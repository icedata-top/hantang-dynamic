import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { markVideoDeleted } from "./videos";

interface QueryCall {
  sql: string;
  values?: unknown[];
}

function createPool(options: { failCollectionStateUpdate?: boolean } = {}) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (
        options.failCollectionStateUpdate &&
        sql.includes("video_collection_state")
      ) {
        throw new Error("collection state update failed");
      }
      if (sql.includes("INSERT INTO processed_videos")) {
        return { rows: [{ aid: "113646663373638" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as Pool, calls };
}

test("terminal deletion persists BVID identities and sets existing state to priority -1", async () => {
  const { pool, calls } = createPool();

  const aid = await markVideoDeleted(pool, {
    type: "bvid",
    bvid: "BV1J8BuYZEbk",
  });

  assert.equal(aid, 113_646_663_373_638n);
  assert.match(calls[1]?.sql ?? "", /VALUES \(bv2av\(\$1\), \$1/);
  assert.deepEqual(calls[1]?.values, ["BV1J8BuYZEbk", null]);
  assert.match(calls[2]?.sql ?? "", /SET priority = -1/);
  assert.match(calls[2]?.sql ?? "", /next_minute_due_at = NULL/);
  assert.deepEqual(
    calls.map((call) => call.sql),
    ["BEGIN", calls[1]?.sql ?? "", calls[2]?.sql ?? "", "COMMIT"],
  );
});

test("terminal deletion persists numeric AID identities without BVID conversion", async () => {
  const { pool, calls } = createPool();

  await markVideoDeleted(pool, { type: "aid", aid: 113_646_663_373_638n });

  assert.match(
    calls[1]?.sql ?? "",
    /VALUES \(\$1::bigint, av2bv\(\$1::bigint\)/,
  );
  assert.doesNotMatch(calls[1]?.sql ?? "", /bv2av/);
  assert.deepEqual(calls[1]?.values, ["113646663373638", null]);
  assert.deepEqual(calls[2]?.values, ["113646663373638"]);
});

test("terminal deletion rolls back processed deletion when collection state transition fails", async () => {
  const { pool, calls } = createPool({ failCollectionStateUpdate: true });

  await assert.rejects(
    markVideoDeleted(pool, { type: "aid", aid: 42n }),
    /collection state update failed/,
  );

  assert.equal(
    calls.some((call) => call.sql === "COMMIT"),
    false,
  );
  assert.equal(calls[calls.length - 1]?.sql, "ROLLBACK");
});
