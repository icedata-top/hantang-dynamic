import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { selectDueMinuteVideos } from "./collectionState";
import {
  initCollectionStateSchema,
  repairDeletedVideoCollectionStates,
} from "./schema/collection_state";
import { initializeSchema } from "./schema/index";

test("deleted collection-state repair only changes stale deleted rows", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: queries.length === 1 ? 1 : 0 };
    },
  } as Pool;

  const repaired = await repairDeletedVideoCollectionStates(pool);
  const repeatedRepair = await repairDeletedVideoCollectionStates(pool);
  const query = queries[0] ?? "";

  assert.equal(repaired, 1);
  assert.equal(repeatedRepair, 0);
  assert.equal(queries[1], query);
  assert.match(query, /UPDATE video_collection_state AS state/);
  assert.match(query, /FROM processed_videos AS video/);
  assert.match(query, /video\.is_deleted IS TRUE/);
  assert.match(query, /SET priority = -1/);
  assert.match(query, /next_minute_due_at = NULL/);
  assert.match(query, /state\.priority IS DISTINCT FROM -1/);
  assert.match(query, /OR state\.next_minute_due_at IS NOT NULL/);
});

test("schema initialization reconciles historical deleted collection state", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

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

test("daily refresh terminals deleted state and minute predicates exclude it", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(schemaSql, /WHEN video\.is_deleted IS TRUE THEN -1/);
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

test("collection-state schema adds Watch Later state before replacing the due-video function signature", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

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
