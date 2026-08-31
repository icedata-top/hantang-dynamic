import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool } from "pg";
import { syncVideoDailyRange, VIDEO_DAILY_SYNC_BATCH_SIZE } from "./videoDaily";

test("explicit video daily backfill requires a valid fixed range", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = new EventEmitter();
  const pool = {
    async connect() {
      return Object.assign(client, {
        async query(sql: string, values?: unknown[]) {
          calls.push({ sql, values });
          client.emit("notice", {
            message: "video_daily sync: completed date 2026-06-09",
          });
          return { rows: [], rowCount: 0 };
        },
        release() {},
      });
    },
  } as unknown as Pool;
  const progress: string[] = [];

  await syncVideoDailyRange(pool, {
    startDate: "2026-06-09",
    endDate: "2026-08-29",
    onProgress(message) {
      progress.push(message);
    },
  });

  assert.deepEqual(calls, [
    {
      sql: "CALL sync_video_daily_from_mysql($1::date, $2::date, $3::integer)",
      values: ["2026-06-09", "2026-08-29", VIDEO_DAILY_SYNC_BATCH_SIZE],
    },
  ]);
  assert.deepEqual(progress, ["video_daily sync: completed date 2026-06-09"]);

  calls.length = 0;
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
