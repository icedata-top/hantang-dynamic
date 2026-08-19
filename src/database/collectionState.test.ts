import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { initCollectionStateSchema } from "./schema/collection_state";

test("daily refresh and due selection preserve terminal deleted collection state", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCollectionStateSchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(schemaSql, /WHEN video_collection_state\.priority = -1 THEN -1/);
  assert.match(
    schemaSql,
    /WHEN video_collection_state\.priority = -1 THEN NULL/,
  );
  assert.match(schemaSql, /FROM video_collection_state\s+WHERE priority > 0/);
});
