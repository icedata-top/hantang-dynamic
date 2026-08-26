import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  getDesiredWatchLaterSet,
  syncWatchLaterSnapshot,
} from "./watchLater";

test("desired sets use deterministic 600/400 pools for one through three accounts", async () => {
  for (const accounts of [1, 2, 3]) {
    let query = "";
    let values: unknown[] | undefined;
    await getDesiredWatchLaterSet(
      {
        async query(sql: string, parameters?: unknown[]) {
          query = sql;
          values = parameters;
          return { rows: [] };
        },
      } as Pool,
      accounts * 1_000,
    );
    assert.match(query, /LIMIT \(\$1 \* 3 \/ 5\)/);
    assert.match(query, /\(\$1 \* 2 \/ 5\)/);
    assert.match(query, /ORDER BY priority ASC, aid ASC/);
    assert.match(
      query,
      /ORDER BY video\.pubdate DESC NULLS LAST, video\.aid DESC/,
    );
    assert.deepEqual(values, [accounts * 1_000]);
  }
});

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
  assert.match(
    membership,
    /AND NOT \(\$1::bigint = ANY\(watch_later_managed_account_ids\)\)/,
  );
  assert.doesNotMatch(membership, /INSERT/);
});

test("snapshot synchronization adds and removes only the observed account UID", async () => {
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
    [1n, 2n],
    new Date(),
  );
  const membership =
    queries.find((sql) => sql.includes("UPDATE video_collection_state")) ?? "";
  assert.match(
    membership,
    /array_append\(watch_later_managed_account_ids, \$1::bigint\)/,
  );
  assert.match(
    membership,
    /array_remove\(watch_later_managed_account_ids, \$1::bigint\)/,
  );
  assert.match(
    membership,
    /WHERE aid = ANY\(\$2::bigint\[\]\)\s+OR \$1::bigint = ANY/,
  );
  assert.doesNotMatch(
    membership,
    /array_remove\(watch_later_managed_account_ids, -1\)/,
  );
});
