import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { disableDeletedVideoCollectionState } from "./collectionState";

test("deleted collection state disables only active minute scheduling", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [], rowCount: 1 };
    },
  } as Pool;

  const disabled = await disableDeletedVideoCollectionState(pool, 42n);

  assert.equal(disabled, true);
  assert.match(query, /SET priority = 0/);
  assert.match(query, /next_minute_due_at = NULL/);
  assert.match(query, /WHERE aid = \$1::bigint\s+AND priority > 0/);
  assert.deepEqual(values, ["42"]);
});
