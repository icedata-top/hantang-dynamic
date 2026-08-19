import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
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
