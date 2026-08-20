import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { syncWatchLaterSnapshot } from "./watchLater";

test("complete snapshots synchronize one UID without creating remote-only state", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  await syncWatchLaterSnapshot(
    {
      async connect() {
        return client;
      },
    } as Pool,
    7n,
    [1n],
    new Date(),
  );
  const membership =
    queries.find((sql) => sql.includes("UPDATE video_collection_state")) ?? "";
  assert.match(membership, /aid = ANY\(\$2::bigint\[\]\)/);
  assert.match(membership, /array_append/);
  assert.match(membership, /array_remove/);
  assert.doesNotMatch(membership, /INSERT/);
});
