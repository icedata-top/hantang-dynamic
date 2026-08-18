import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  resolveWatchLaterOperation,
  withWatchLaterAccountLease,
} from "./watchLater";

test("successful delete removes only the operation account from ownership", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT operation_id")) {
        return {
          rows: [
            {
              operation_id: "00000000-0000-0000-0000-000000000001",
              account_id: "42",
              aid: "99",
              action: "delete",
              intent_at: new Date(),
              request_attempt_count: 1,
              last_request_at: new Date(),
              result_classification: "pending",
              result_code: null,
              provenance_run_ref: null,
              resolved_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [],
        rowCount: sql.includes("video_collection_state") ? 1 : 1,
      };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as Pool;

  const resolved = await resolveWatchLaterOperation(pool, {
    operationId: "00000000-0000-0000-0000-000000000001",
    resultClassification: "succeeded",
    resultCode: 0,
  });

  assert.equal(resolved, true);
  const ownership = queries.find(({ sql }) =>
    sql.includes("UPDATE video_collection_state"),
  );
  assert.match(ownership?.sql ?? "", /WHEN \$3 = 'delete'\s+THEN array_remove/);
  assert.deepEqual(ownership?.values, ["99", "42", "delete"]);
});

test("account lease is persisted before work and released afterward", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as Pool;

  const result = await withWatchLaterAccountLease(pool, 42n, async () => {
    return "completed";
  });

  assert.equal(result, "completed");
  assert.match(queries[0]?.sql ?? "", /SET lease_token = \$2::uuid/);
  assert.match(queries[1]?.sql ?? "", /SET lease_token = NULL/);
});
