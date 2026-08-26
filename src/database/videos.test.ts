import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { initVideosSchema } from "./schema/videos";
import {
  markVideoDeleted,
  markVideoProcessedWithCollectionState,
  updateProcessedVideoPidV2,
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

test("authoritative TAG relations are replaced in the processed-video transaction", async () => {
  const { pool, calls } = createPool();

  await markVideoProcessedWithCollectionState(
    pool,
    {
      ...video,
      mission_id: 99n,
      tagSnapshot: [
        { tagId: 10n, tagName: "vocaloid" },
        { tagId: 20n, tagName: "topic" },
      ],
    },
    true,
  );

  assert.match(calls[1]?.sql ?? "", /mission_id = EXCLUDED\.mission_id/);
  assert.equal(calls[1]?.values?.[19], "99");
  assert.match(calls[2]?.sql ?? "", /INSERT INTO tags/);
  assert.deepEqual(calls[2]?.values, [
    ["10", "20"],
    ["vocaloid", "topic"],
  ]);
  assert.match(calls[3]?.sql ?? "", /DELETE FROM video_tags/);
  assert.match(calls[4]?.sql ?? "", /INSERT INTO video_tags/);
  assert.match(
    calls[5]?.sql ?? "",
    /fn_upsert_collection_state_from_processed_video/,
  );
  assert.equal(calls[6]?.sql, "COMMIT");
});

test("missing TAG snapshots preserve stored names and normalized relations", async () => {
  const { pool, calls } = createPool();

  await markVideoProcessedWithCollectionState(pool, video, true);

  assert.match(
    calls[1]?.sql ?? "",
    /WHEN \$23::boolean THEN EXCLUDED\.tag\s+ELSE processed_videos\.tag/,
  );
  assert.match(
    calls[1]?.sql ?? "",
    /WHEN \$23::boolean THEN EXCLUDED\.tag_new\s+ELSE processed_videos\.tag_new/,
  );
  assert.equal(calls[1]?.values?.[22], false);
  assert.equal(
    calls.some((call) => call.sql.includes("DELETE FROM video_tags")),
    false,
  );
});

test("authoritative empty TAG snapshots clear names and normalized relations", async () => {
  const { pool, calls } = createPool();

  await markVideoProcessedWithCollectionState(
    pool,
    { ...video, tag_new: [], tagSnapshot: [] },
    true,
  );

  assert.equal(calls[1]?.values?.[5], "");
  assert.deepEqual(calls[1]?.values?.[13], []);
  assert.equal(calls[1]?.values?.[22], true);
  assert.deepEqual(calls[2]?.values, [[], []]);
  assert.match(calls[3]?.sql ?? "", /DELETE FROM video_tags/);
  assert.deepEqual(calls[4]?.values, ["42", []]);
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

test("pid_v2 metadata updates only matching changed videos", async () => {
  const calls: QueryCall[] = [];
  const query = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 2 };
    },
  };

  const updated = await updateProcessedVideoPidV2(query as unknown as Pool, [
    { aid: 1n, pidV2: 22 },
    { aid: 2n, pidV2: 33 },
  ]);

  assert.equal(updated, 2);
  assert.deepEqual(calls[0]?.values, [
    ["1", "2"],
    [22, 33],
  ]);
  assert.match(calls[0]?.sql ?? "", /video\.aid = metadata\.aid/);
  assert.match(calls[0]?.sql ?? "", /video\.aid = ANY\(\$1::bigint\[\]\)/);
  assert.match(
    calls[0]?.sql ?? "",
    /video\.pid_v2 IS DISTINCT FROM metadata\.pid_v2/,
  );
});

test("mission backfill advances through eligible AIDs in bounded batches", async () => {
  const backfillCursors: unknown[] = [];
  const batches = [
    Array.from({ length: 1_000 }, (_, index) => ({ aid: String(index + 1) })),
    Array.from({ length: 1_000 }, (_, index) => ({
      aid: String(index + 1_001),
    })),
    Array.from({ length: 500 }, (_, index) => ({
      aid: String(index + 2_001),
    })),
  ];
  let countCalls = 0;
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("count(*)::text AS remaining")) {
        countCalls += 1;
        return {
          rows: [{ remaining: countCalls === 1 ? "2500" : "0" }],
          rowCount: 1,
        };
      }
      if (sql.includes("WITH candidates AS")) {
        backfillCursors.push(values?.[0]);
        const rows = batches.shift() ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await initVideosSchema(pool);

  assert.deepEqual(backfillCursors, [null, "1000", "2000"]);
  assert.equal(countCalls, 2);
  assert.equal(batches.length, 0);
});
