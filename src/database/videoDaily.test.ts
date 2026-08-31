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
          if (sql.startsWith("CALL")) {
            client.emit("notice", {
              message: "video_daily sync: completed date 2026-06-09",
            });
          }
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
    schema: "hantang_dynamic",
    onProgress(message) {
      progress.push(message);
    },
  });

  assert.deepEqual(calls[0], {
    sql: "CALL sync_video_daily_from_mysql($1::date, $2::date, $3::integer)",
    values: ["2026-06-09", "2026-08-29", VIDEO_DAILY_SYNC_BATCH_SIZE],
  });
  assert.match(calls[1]?.sql ?? "", /pg_advisory_unlock/);
  assert.deepEqual(calls[1]?.values, ["hantang_dynamic"]);
  assert.deepEqual(progress, ["video_daily sync: completed date 2026-06-09"]);

  calls.length = 0;
  await syncVideoDailyRange(pool, {
    startDate: "2026-06-09",
    endDate: "2026-08-29",
    schema: "hantang_dynamic",
    batchSize: 2_000,
  });

  assert.deepEqual(calls[0], {
    sql: "CALL sync_video_daily_from_mysql($1::date, $2::date, $3::integer)",
    values: ["2026-06-09", "2026-08-29", 2_000],
  });
  assert.match(calls[1]?.sql ?? "", /pg_advisory_unlock/);
  assert.deepEqual(calls[1]?.values, ["hantang_dynamic"]);
  await assert.rejects(
    syncVideoDailyRange(pool, {
      startDate: "2026-08-30",
      endDate: "2026-06-09",
      schema: "hantang_dynamic",
    }),
    /start date must not be after end date/,
  );
});

test("failed video daily backfill unlocks before releasing the client", async () => {
  const calls: string[] = [];
  let released = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      calls.push(sql);
      if (calls.length === 1) {
        throw new Error("sync failed");
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  });
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;

  await assert.rejects(
    syncVideoDailyRange(pool, {
      startDate: "2026-07-04",
      endDate: "2026-07-04",
      schema: "hantang_dynamic",
    }),
    /sync failed/,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /pg_advisory_unlock/);
  assert.equal(client.listenerCount("notice"), 0);
  assert.equal(released, true);
});
