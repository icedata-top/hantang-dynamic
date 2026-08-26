import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  markVideoDeleted,
  markVideoProcessedWithCollectionState,
} from "./videos";

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
        sql.includes("collection_state")
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

const video = {
  aid: 42n,
  bvid: "BV1test",
  user_id: 7n,
  type_id: 3,
  tid_v2: 2022,
  title: "eligible video",
  description: "",
  pic: "",
  tag: "",
  pubdate: 1_700_000_000,
  ctime: 1_700_000_000,
};

test("processed video and collection state commit in one transaction", async () => {
  const { pool, calls } = createPool();

  await markVideoProcessedWithCollectionState(
    pool,
    video,
    true,
    new Date("2026-08-26T00:00:00Z"),
  );

  assert.equal(calls[0]?.sql, "BEGIN");
  assert.match(calls[1]?.sql ?? "", /INSERT INTO processed_videos/);
  assert.match(
    calls[2]?.sql ?? "",
    /fn_upsert_collection_state_from_processed_video/,
  );
  assert.deepEqual(calls[2]?.values?.slice(0, 9), [
    "42",
    1_700_000_000,
    1_700_000_000,
    2022,
    null,
    null,
    null,
    false,
    true,
  ]);
  assert.equal(calls[3]?.sql, "COMMIT");
});

test("processed video insert rolls back when collection state upsert fails", async () => {
  const { pool, calls } = createPool({ failCollectionStateUpdate: true });

  await assert.rejects(
    markVideoProcessedWithCollectionState(pool, video, true),
    /collection state update failed/,
  );

  assert.equal(
    calls.some((call) => call.sql === "COMMIT"),
    false,
  );
  assert.equal(calls[calls.length - 1]?.sql, "ROLLBACK");
});

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
