import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  getLatestVideoMinuteSamples,
  insertVideoMinuteSamples,
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
