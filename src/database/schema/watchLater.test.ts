import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { getWatchLaterAccounts } from "../watchLater";
import { initWatchLaterSchema } from "./watchLater";

test("watch-later upgrade makes a pre-change schema queryable before minute sampling", async () => {
  let upgraded = false;
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM watch_later_account")) {
        if (!upgraded)
          throw new Error('relation "watch_later_account" does not exist');
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("CREATE INDEX")) upgraded = true;
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await assert.rejects(getWatchLaterAccounts(pool, []), /does not exist/);
  await initWatchLaterSchema(pool);
  assert.deepEqual(await getWatchLaterAccounts(pool, []), []);
  assert.ok(
    queries.findIndex((sql) => sql.includes("CREATE TABLE")) <
      queries.findIndex((sql) => sql.includes("CREATE INDEX")),
  );
});
