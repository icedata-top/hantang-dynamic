import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  advanceFailedMinuteVideos,
  advanceSuppressedMinuteSamples,
  selectDueMinuteVideos,
} from "./collectionState";
import {
  initCollectionStateSchema,
  repairInactiveVideoCollectionStates,
} from "./schema/collection_state";
import { initializeSchema } from "./schema/index";

function createSchemaInitializationPool(queries: string[]): Pool {
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.includes("FROM pg_extension")) {
      return { rows: [{ installed: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as Pool;
}

test("failed minute advancement carries attempt and completion times", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [{ count: 1 }], rowCount: 1 };
    },
  } as Pool;
  const attemptStartedAt = new Date("2026-08-20T00:00:00.000Z");
  const completedAt = new Date("2026-08-20T00:02:00.000Z");

  const count = await advanceFailedMinuteVideos(
    pool,
    [1n],
    attemptStartedAt,
    completedAt,
  );

  assert.equal(count, 1);
  assert.match(
    query,
    /fn_advance_failed_minute_videos\(\$1::bigint\[\], \$2, \$3\)/,
  );
  assert.deepEqual(values, [["1"], attemptStartedAt, completedAt]);
});

test("inactive collection-state repair terminals deleted and filtered rows", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: queries.length === 1 ? 1 : 0 };
    },
  } as Pool;

  const repaired = await repairInactiveVideoCollectionStates(pool);
  const repeatedRepair = await repairInactiveVideoCollectionStates(pool);
  const query = queries[0] ?? "";

  assert.equal(repaired, 1);
  assert.equal(repeatedRepair, 0);
  assert.equal(queries[1], query);
  assert.match(query, /UPDATE video_collection_state AS state/);
  assert.match(query, /FROM processed_videos AS video/);
  assert.match(
    query,
    /video\.is_deleted IS TRUE OR video\.is_filtered IS FALSE/,
  );
  assert.match(query, /SET priority = -1/);
  assert.match(query, /next_minute_due_at = NULL/);
  assert.match(query, /state\.priority IS DISTINCT FROM -1/);
  assert.match(query, /OR state\.next_minute_due_at IS NOT NULL/);
});

test("schema initialization reconciles historical inactive collection state", async () => {
  const queries: string[] = [];
  const pool = createSchemaInitializationPool(queries);

  await initializeSchema(pool, "public");

  const processedVideos = queries.findIndex((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS processed_videos"),
  );
  const repair = queries.findIndex((sql) =>
    sql.includes("UPDATE video_collection_state AS state"),
  );
  assert.ok(processedVideos >= 0);
  assert.ok(repair > processedVideos);
});

test("daily refresh terminals deleted and filtered state and excludes it", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(
    schemaSql,
    /WHEN video\.is_deleted IS TRUE OR video\.is_filtered IS FALSE THEN -1/,
  );
  assert.match(
    schemaSql,
    /WHEN video_collection_state\.priority = -1 OR EXCLUDED\.priority = -1 THEN -1/,
  );
  assert.match(
    schemaSql,
    /WHEN video_collection_state\.priority = -1 OR EXCLUDED\.priority = -1 THEN NULL/,
  );
  assert.match(schemaSql, /FROM video_collection_state\s+WHERE priority > 0/);
});

test("suppressed samples advance latest observation without inserting history", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [{ count: 2 }], rowCount: 1 };
    },
  } as Pool;
  const firstTime = new Date("2026-08-20T00:00:00.000Z");
  const secondTime = new Date("2026-08-20T00:01:00.000Z");

  const count = await advanceSuppressedMinuteSamples(pool, [
    { aid: 1n, time: firstTime, view: 100 },
    { aid: 2n, time: secondTime, view: 200 },
  ]);

  assert.equal(count, 2);
  assert.match(query, /fn_advance_suppressed_minute_samples/);
  assert.doesNotMatch(query, /INSERT INTO video_minute/);
  assert.deepEqual(values, [
    ["1", "2"],
    [firstTime, secondTime],
    [100, 200],
  ]);
});

test("suppressed and persisted samples preserve view-change semantics", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(
    schemaSql,
    /o\.observed_view IS DISTINCT FROM s\.last_view AS view_changed/,
  );
  assert.match(schemaSql, /last_view = d\.observed_view/);
  assert.match(
    schemaSql,
    /WHEN d\.view_changed THEN d\.observed_at\s+ELSE s\.last_view_change_at/,
  );
  assert.match(
    schemaSql,
    /WHEN c\.latest_view IS DISTINCT FROM s\.last_view THEN c\."time"\s+ELSE s\.last_view_change_at/,
  );
});

test("normal suppressed samples use the grid-aligned next due time", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const suppressedSql = queries.find((sql) =>
    sql.includes(
      "CREATE OR REPLACE FUNCTION fn_advance_suppressed_minute_samples",
    ),
  );
  assert.ok(suppressedSql);
  assert.match(
    suppressedSql,
    /fn_video_collection_next_due_at\(\s*s\.aid,\s*s\.priority,\s*o\.observed_at \+ interval '1 second'\s*\) AS normal_due_at/,
  );
  assert.match(suppressedSql, /d\.burst_start < d\.normal_due_at/);
  assert.match(suppressedSql, /ELSE d\.normal_due_at/);
});

test("late and equal observations cannot replace newer collection state", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(schemaSql, /o\.observed_at > s\.last_minute_success_at/);
  assert.match(schemaSql, /l\."time" > s\.last_minute_success_at/);
  assert.match(schemaSql, /d\.observed_at > s\.last_minute_success_at/);
  assert.match(schemaSql, /c\."time" > s\.last_minute_success_at/);
});

test("failed attempts only reschedule state without a newer successful observation", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const failureAdvanceSql = queries.find((sql) =>
    sql.includes("CREATE OR REPLACE FUNCTION fn_advance_failed_minute_videos"),
  );
  assert.ok(failureAdvanceSql);
  assert.match(
    failureAdvanceSql,
    /last_minute_success_at IS NULL\s+OR s\.last_minute_success_at < p_attempt_started_at/,
  );
  assert.match(failureAdvanceSql, /p_now \+ interval '1 second'/);
  assert.match(failureAdvanceSql, /updated_at = p_now/);
});

test("collection-state schema adds Watch Later state before replacing the due-video function signature", async () => {
  const queries: string[] = [];
  const pool = createSchemaInitializationPool(queries);

  await initializeSchema(pool, "public");

  const collectionStateTable = queries.findIndex((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS video_collection_state"),
  );
  const managedAccountColumn = queries.findIndex((sql) =>
    sql.includes("ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids"),
  );
  const dropDueFunction = queries.findIndex((sql) =>
    sql.includes("DROP FUNCTION IF EXISTS fn_select_due_minute_videos"),
  );
  const createDueFunction = queries.findIndex((sql) =>
    sql.includes("CREATE OR REPLACE FUNCTION fn_select_due_minute_videos"),
  );

  assert.ok(collectionStateTable >= 0);
  assert.ok(managedAccountColumn > collectionStateTable);
  assert.ok(dropDueFunction > managedAccountColumn);
  assert.ok(createDueFunction > dropDueFunction);
  assert.equal(
    queries.filter((sql) =>
      sql.includes("DROP FUNCTION IF EXISTS fn_select_due_minute_videos"),
    ).length,
    1,
  );
  assert.equal(
    queries.filter((sql) =>
      sql.includes("CREATE OR REPLACE FUNCTION fn_select_due_minute_videos"),
    ).length,
    1,
  );
  assert.match(
    queries[createDueFunction] ?? "",
    /RETURNS TABLE \(aid bigint, last_view bigint, near_gate boolean, due_at timestamptz, watch_later_managed_account_ids bigint\[\]\)/,
  );
});

test("due minute video decoding preserves the function Watch Later array", async () => {
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const now = new Date("2026-08-20T13:45:00.000Z");
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return {
        rows: [
          {
            aid: "722988196",
            last_view: "10880",
            near_gate: false,
            due_at: "2026-08-20T13:45:00.000Z",
            watch_later_managed_account_ids: ["3691008040634728"],
          },
        ],
      };
    },
  } as unknown as Pool;

  const due = await selectDueMinuteVideos(pool, 50, now);

  assert.deepEqual(due, [
    {
      aid: 722988196n,
      lastView: 10880n,
      nearGate: false,
      dueAt: now,
      watchLaterManagedAccountIds: [3691008040634728n],
    },
  ]);
  assert.match(
    queries[0]?.sql ?? "",
    /SELECT aid, last_view, near_gate, due_at, watch_later_managed_account_ids FROM fn_select_due_minute_videos/,
  );
  assert.deepEqual(queries[0]?.values, [now, 50]);
});
