import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { syncVideoDailyRange } from "./videoDaily";

test("explicit video daily backfill requires a valid fixed range", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await syncVideoDailyRange(pool, {
    startDate: "2026-06-09",
    endDate: "2026-08-29",
    batchSize: 2_000,
  });

  assert.deepEqual(calls, [
    {
      sql: "CALL sync_video_daily_from_mysql($1::date, $2::date, $3::integer)",
      values: ["2026-06-09", "2026-08-29", 2_000],
    },
  ]);
  await assert.rejects(
    syncVideoDailyRange(pool, {
      startDate: "2026-08-30",
      endDate: "2026-06-09",
    }),
    /start date must not be after end date/,
  );
});
