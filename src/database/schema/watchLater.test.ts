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
  assert.ok(
    queries.findIndex((sql) => sql.includes("CREATE TABLE")) <
      queries.findIndex((sql) => sql.includes("CREATE INDEX")),
  );
  assert.ok(queries.every((sql) => !/DROP\s+(COLUMN|CONSTRAINT)/.test(sql)));
  assert.doesNotMatch(
    queries.find((sql) => sql.includes("CREATE TABLE watch_later_account")) ??
      "",
    /target_count|configured_capacity|remote_capacity/,
  );
});
