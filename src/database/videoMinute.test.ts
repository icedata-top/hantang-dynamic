import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { getLatestVideoMinuteSample } from "./videoMinute";

test("latest minute lookup returns partial rows with nullable counters", async () => {
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

  const sample = await getLatestVideoMinuteSample(pool, 9_007_199_254_740_993n);

  assert.deepEqual(sample, {
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
  assert.match(query, /WHERE aid = \$1\s+AND "view" IS NOT NULL/);
  assert.doesNotMatch(query, /favorite IS NOT NULL/);
  assert.deepEqual(values, ["9007199254740993"]);
});
