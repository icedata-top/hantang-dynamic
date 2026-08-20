import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { initWatchLaterSchema } from "./watchLater";

test("watch-later initialization creates the final schema without destructive migration", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initWatchLaterSchema(pool);
  assert.ok(queries.every((sql) => !/DROP\s+(COLUMN|CONSTRAINT)/.test(sql)));
  assert.deepEqual(queries.join("\n").match(/DROP\s+\w+/g) ?? [], [
    "DROP FUNCTION",
  ]);
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
  assert.doesNotMatch(
    queries.find((sql) => sql.includes("CREATE TABLE watch_later_account")) ??
      "",
    /target_count|configured_capacity|remote_capacity/,
  );
  assert.doesNotMatch(queries.join("\n"), /watch_later_account_operation/);
});
