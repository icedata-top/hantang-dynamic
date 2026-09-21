import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  getLatestVideoMinuteSamples,
  insertVideoMinuteSamples,
  insertVideoMinuteSamplesWithGateCrossings,
} from "./videoMinute";

test("late minute observations remain insertable as history", async () => {
  let query = "";
  const pool = {
    async query(sql: string) {
      query = sql;
      return { rows: [], rowCount: 1 };
    },
  } as Pool;
  const lateObservation = new Date("2026-08-18T00:00:00.000Z");

  const inserted = await insertVideoMinuteSamples(pool, [
    { aid: 1n, time: lateObservation, view: 100 },
  ]);

  assert.equal(inserted, 1);
  assert.match(query, /INSERT INTO video_minute/);
});

test("latest minute batch lookup returns partial rows with nullable counters", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return {
        rows: [
          {
            aid: "9007199254740993",
            time: new Date("2026-08-18T00:00:00.000Z"),
            coin: null,
            favorite: 2,
            danmaku: 3,
            view: 100,
            reply: 4,
            share: null,
            like: null,
          },
        ],
      };
    },
  } as Pool;

  const samples = await getLatestVideoMinuteSamples(pool, [
    9_007_199_254_740_993n,
    42n,
  ]);

  assert.deepEqual(samples.get(9_007_199_254_740_993n), {
    aid: 9_007_199_254_740_993n,
    time: new Date("2026-08-18T00:00:00.000Z"),
    coin: null,
    favorite: 2,
    danmaku: 3,
    view: 100,
    reply: 4,
    share: null,
    like: null,
  });
  assert.equal(samples.has(42n), false);
  assert.match(query, /SELECT DISTINCT ON \(aid\)/);
  assert.match(query, /WHERE aid = ANY\(\$1::bigint\[\]\)/);
  assert.doesNotMatch(query, /favorite IS NOT NULL/);
  assert.deepEqual(values, [["9007199254740993", "42"]]);
});

test("minute persistence locks affected state before attributing a new crossing", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("video_collection_gate_crossings")) {
        const reads = queries.filter((query) =>
          query.includes("video_collection_gate_crossings"),
        ).length;
        return reads === 1
          ? { rows: [] }
          : { rows: [{ aid: "1", gate_value: "1000" }] };
      }
      if (sql.includes("INSERT INTO video_minute"))
        return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;

  const result = await insertVideoMinuteSamplesWithGateCrossings(pool, [
    { aid: 1n, time: new Date("2026-08-18T00:01:00.000Z"), view: 1_001 },
  ]);

  assert.deepEqual(result, {
    inserted: 1,
    gateCrossings: [{ aid: 1n, gateValue: 1_000n }],
  });
  const lock = queries.findIndex((query) => query.includes("FOR UPDATE"));
  const insert = queries.findIndex((query) =>
    query.includes("INSERT INTO video_minute"),
  );
  assert.ok(lock >= 0 && lock < insert);
  assert.match(queries[lock] ?? "", /ORDER BY aid/);
  assert.ok(queries.includes("COMMIT"));
});

test("gate lookup failure commits the minute sample without a crossing callback", async () => {
  let calls = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO video_minute"))
        return { rows: [], rowCount: 1 };
      if (sql.includes("video_collection_gate_crossings")) {
        const reads = calls++;
        if (reads === 1) throw new Error("gate lookup failed");
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;

  const result = await insertVideoMinuteSamplesWithGateCrossings(pool, [
    { aid: 1n, time: new Date("2026-08-18T00:01:00.000Z"), view: 1_001 },
  ]);

  assert.equal(result.inserted, 1);
  assert.deepEqual(result.gateCrossings, []);
  assert.equal(result.gateCrossingsError instanceof Error, true);
});
