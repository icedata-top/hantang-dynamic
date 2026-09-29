import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { initWatchLaterSchema } from "./watchLater";

test("watch-later initialization prepares collection membership selection", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initWatchLaterSchema(pool);
  assert.match(
    queries[0] ?? "",
    /ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids/,
  );
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
});
