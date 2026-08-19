import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  getDesiredWatchLaterSet,
  getWatchLaterAccounts,
  getWatchLaterEligibleAids,
  markWatchLaterEmpiricalFailedAid,
  provisionWatchLaterAccounts,
  resolveWatchLaterOperation,
  withWatchLaterAccountLease,
} from "./watchLater";

test("watch-later account lookup selects only supplied account identities", async () => {
  let query = "";
  const pool = {
    async query(sql: string, values?: unknown[]) {
      query = sql;
      assert.deepEqual(values, [["7"]]);
      return {
        rows: [
          {
            account_id: "7",
            capacity_blocked_at: null,
            last_complete_snapshot_at: null,
          },
        ],
      };
    },
  } as Pool;

  const accounts = await getWatchLaterAccounts(pool, [7n]);

  assert.equal(accounts[0]?.accountId, 7n);
  assert.doesNotMatch(query, /configured_capacity/);
  assert.match(query, /account_id = ANY\(\$1::bigint\[\]\)/);
});

test("provisioning uses only loaded enabled account identities", async () => {
  const values: unknown[][] = [];
  const pool = {
    async query(_sql: string, queryValues?: unknown[]) {
      values.push(queryValues ?? []);
      return { rows: [], rowCount: 1 };
    },
  } as Pool;

  await provisionWatchLaterAccounts(pool, [7n, 8n]);

  assert.deepEqual(values, [["7"], ["8"]]);
});

test("empirical candidates include priority 29 and exclude priority 30", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [] };
    },
  } as Pool;
  await getWatchLaterEligibleAids(pool, 30);
  assert.match(query, /priority >= 1/);
  assert.match(query, /priority < \$1/);
  assert.match(query, /NOT \(-1 = ANY\(watch_later_managed_account_ids\)\)/);
  assert.doesNotMatch(query, /LIMIT/);
  assert.deepEqual(values, [30]);
});

test("desired Watch Later query bounds the 600/400 pools and excludes sentinels", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [{ aid: "1" }, { aid: "2" }] };
    },
  } as Pool;

  const desired = await getDesiredWatchLaterSet(pool, 1_000);

  assert.deepEqual(desired, {
    aids: [1n, 2n],
    mandatoryCount: 2,
    overflow: false,
  });
  assert.match(query, /priority > 0/);
  assert.match(query, /ORDER BY priority ASC, aid ASC/);
  assert.match(query, /LIMIT \(\$1 \* 3 \/ 5\)/);
  assert.match(query, /INNER JOIN processed_videos AS video/);
  assert.match(query, /video\.is_filtered = TRUE/);
  assert.match(
    query,
    /ORDER BY video\.pubdate DESC NULLS LAST, video\.aid DESC/,
  );
  assert.match(
    query,
    /GREATEST\(\$1 - \(SELECT count\(\*\) FROM priority_candidates\), 0\)/,
  );
  assert.match(query, /\(\$1 \* 2 \/ 5\)/);
  assert.match(query, /NOT EXISTS/);
  assert.equal(
    query.match(
      /NOT \(-1 = ANY\((?:state\.)?watch_later_managed_account_ids\)\)/g,
    )?.length,
    2,
  );
  assert.deepEqual(values, [1_000]);
});

test("empirical failed candidates are marked with the global exclusion sentinel", async () => {
  let query = "";
  let values: unknown[] | undefined;
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      query = sql;
      values = parameters;
      return { rows: [], rowCount: 1 };
    },
  } as Pool;

  const marked = await markWatchLaterEmpiricalFailedAid(pool, 42n);

  assert.equal(marked, true);
  assert.match(query, /array_append\(watch_later_managed_account_ids, -1\)/);
  assert.match(query, /WHERE aid = \$1::bigint/);
  assert.deepEqual(values, ["42"]);
});

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

test("successful delete resolves unmanaged remote entries without collection state", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("SELECT operation_id")) {
        return {
          rows: [
            {
              operation_id: "00000000-0000-0000-0000-000000000002",
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
      if (sql.includes("UPDATE video_collection_state")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as Pool;

  const resolved = await resolveWatchLaterOperation(pool, {
    operationId: "00000000-0000-0000-0000-000000000002",
    resultClassification: "succeeded",
    resultCode: 0,
  });

  assert.equal(resolved, true);
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
