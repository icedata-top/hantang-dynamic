import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { upgradeVideoHistoryTagIdentitySchema } from "./schema/video_history";
import { backfillMissionIds } from "./schema/videos";
import {
  getProcessedVideoAids,
  markVideoDeleted,
  markVideoProcessedWithCollectionState,
  markVideosProcessedWithCollectionState,
  refreshProcessedVideosFromRecommendations,
  updateProcessedVideoMetadata,
} from "./videos";

interface QueryCall {
  sql: string;
  values?: unknown[];
}

function createPool(
  options: {
    existingAidForBvid?: string;
    failCollectionStateUpdate?: boolean;
  } = {},
) {
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
      if (sql.includes("SELECT aid") && sql.includes("WHERE bvid = $1")) {
        return {
          rows: options.existingAidForBvid
            ? [{ aid: options.existingAidForBvid }]
            : [],
          rowCount: options.existingAidForBvid ? 1 : 0,
        };
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

  assert.match(
    calls[1]?.sql ?? "",
    /mission_id = COALESCE\(EXCLUDED\.mission_id, processed_videos\.mission_id\)/,
  );
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
    /WHEN \$25::boolean THEN EXCLUDED\.tag\s+ELSE processed_videos\.tag/,
  );
  assert.match(
    calls[1]?.sql ?? "",
    /WHEN \$25::boolean THEN EXCLUDED\.tag_new\s+ELSE processed_videos\.tag_new/,
  );
  assert.equal(calls[1]?.values?.[24], false);
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
  assert.equal(calls[1]?.values?.[24], true);
  assert.deepEqual(calls[1]?.values?.[23], []);
  assert.deepEqual(calls[2]?.values, [[], []]);
  assert.match(calls[3]?.sql ?? "", /DELETE FROM video_tags/);
  assert.deepEqual(calls[4]?.values, ["42", []]);
});

test("processed AID lookup uses one bounded set query", async () => {
  const calls: QueryCall[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ aid: "2" }, { aid: "3" }], rowCount: 2 };
    },
  } as unknown as Pool;

  const existing = await getProcessedVideoAids(pool, [1n, 2n, 2n, 3n]);

  assert.deepEqual(existing, new Set([2n, 3n]));
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /WHERE aid = ANY\(\$1::bigint\[\]\)/);
  assert.deepEqual(calls[0]?.values, [["1", "2", "3"]]);
});

test("recommendation refresh deduplicates inputs and preserves manual-state columns", async () => {
  const calls: QueryCall[] = [];
  const query = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };

  const updated = await refreshProcessedVideosFromRecommendations(
    query as unknown as Pool,
    [
      {
        aid: 7n,
        bvid: "BVold",
        title: "old title",
        description: "old description",
        pic: "old pic",
        typeId: 1,
        userId: 2n,
        pubdate: 3,
      },
      {
        aid: 7n,
        bvid: "BVnew",
        title: "new title",
        description: "new description",
        pic: "new pic",
        cover43: "new cover",
        typeId: 4,
        userId: 5n,
        pubdate: 6,
      },
    ],
  );

  assert.equal(updated, 1);
  const payload = JSON.parse(calls[0]?.values?.[0] as string) as Array<{
    bvid: string;
  }>;
  assert.equal(payload.length, 1);
  assert.equal(payload[0]?.bvid, "BVnew");
  assert.match(
    calls[0]?.sql ?? "",
    /video\.title IS DISTINCT FROM incoming\.title/,
  );
  assert.doesNotMatch(calls[0]?.sql ?? "", /is_filtered|notes|tag_ids/);
});

test("terminal deletion persists BVID identities and sets existing state to priority -1", async () => {
  const { pool, calls } = createPool();

  const aid = await markVideoDeleted(pool, {
    type: "bvid",
    bvid: "BV1J8BuYZEbk",
  });

  assert.equal(aid, 113_646_663_373_638n);
  assert.match(calls[1]?.sql ?? "", /FOR UPDATE/);
  assert.deepEqual(calls[1]?.values, ["BV1J8BuYZEbk"]);
  assert.match(calls[2]?.sql ?? "", /VALUES \(bv2av\(\$1\), \$1/);
  assert.deepEqual(calls[2]?.values, ["BV1J8BuYZEbk", null]);
  assert.match(calls[3]?.sql ?? "", /SET priority = -1/);
  assert.match(calls[3]?.sql ?? "", /next_minute_due_at = NULL/);
  assert.deepEqual(calls[3]?.values, [["113646663373638"]]);
  assert.deepEqual(
    calls.map((call) => call.sql),
    [
      "BEGIN",
      calls[1]?.sql ?? "",
      calls[2]?.sql ?? "",
      calls[3]?.sql ?? "",
      "COMMIT",
    ],
  );
});

test("terminal BVID deletion disables stale and corrected AID state", async () => {
  const { pool, calls } = createPool({ existingAidForBvid: "42" });

  await markVideoDeleted(pool, { type: "bvid", bvid: "BV1J8BuYZEbk" });

  assert.deepEqual(calls[3]?.values, [["42", "113646663373638"]]);
  assert.match(calls[3]?.sql ?? "", /WHERE aid = ANY\(\$1::bigint\[\]\)/);
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
  assert.deepEqual(calls[2]?.values, [["113646663373638"]]);
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

test("supplemental metadata updates changed fields and merges duplicate related entries", async () => {
  const calls: QueryCall[] = [];
  const query = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 2 };
    },
  };

  const updated = await updateProcessedVideoMetadata(query as unknown as Pool, [
    { aid: 1n, pidV2: 22 },
    { aid: 1n, cover43: "https://cover/1" },
    { aid: 2n, cover43: "" },
    { aid: 2n, cover43: "https://cover/2" },
  ]);

  assert.equal(updated, 2);
  assert.deepEqual(calls[0]?.values, [
    ["1", "2"],
    [22, null],
    ["https://cover/1", "https://cover/2"],
  ]);
  assert.match(calls[0]?.sql ?? "", /video\.aid = metadata\.aid/);
  assert.match(calls[0]?.sql ?? "", /video\.aid = ANY\(\$1::bigint\[\]\)/);
  assert.match(
    calls[0]?.sql ?? "",
    /video\.pid_v2 IS DISTINCT FROM metadata\.pid_v2/,
  );
  assert.match(
    calls[0]?.sql ?? "",
    /video\.cover43 IS DISTINCT FROM metadata\.cover43/,
  );
});

test("ordinary detail writes preserve an existing cover43 when it is omitted", async () => {
  const { pool, calls } = createPool();

  await markVideoProcessedWithCollectionState(
    pool,
    { ...video, cover43: "" },
    true,
  );

  assert.equal(calls[1]?.values?.[22], null);
  assert.match(
    calls[1]?.sql ?? "",
    /cover43 = COALESCE\(EXCLUDED\.cover43, processed_videos\.cover43\)/,
  );
});

test("full-detail batch writes once per database phase and keeps the final duplicate", async () => {
  const { pool, calls } = createPool();

  const written = await markVideosProcessedWithCollectionState(pool, [
    { video: { ...video, title: "first" }, filtered: true },
    {
      video: {
        ...video,
        title: "final",
        tagSnapshot: [
          { tagId: 20n, tagName: "second" },
          { tagId: 10n, tagName: "first" },
        ],
      },
      filtered: true,
    },
  ]);

  assert.equal(written, 1);
  assert.equal(calls[0]?.sql, "BEGIN");
  assert.match(calls[1]?.sql ?? "", /jsonb_to_recordset/);
  assert.match(
    calls[1]?.sql ?? "",
    /notes = COALESCE\(EXCLUDED\.notes, video\.notes\)/,
  );
  const payload = JSON.parse(calls[1]?.values?.[0] as string) as Array<{
    title: string;
    tag_ids: string[];
  }>;
  assert.equal(payload.length, 1);
  assert.equal(payload[0]?.title, "final");
  assert.deepEqual(payload[0]?.tag_ids, ["10", "20"]);
  assert.match(calls[2]?.sql ?? "", /INSERT INTO tags/);
  assert.match(calls[3]?.sql ?? "", /DELETE FROM video_tags/);
  assert.match(calls[4]?.sql ?? "", /INSERT INTO video_tags/);
  assert.match(
    calls[5]?.sql ?? "",
    /fn_upsert_collection_state_from_processed_video/,
  );
  assert.equal(calls[6]?.sql, "COMMIT");
});

test("history upgrade records cover and compares canonical TAG IDs", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await upgradeVideoHistoryTagIdentitySchema(pool);

  const schemaSql = queries.join("\n");
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS tag_ids BIGINT\[\]/);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS cover43 VARCHAR/);
  assert.match(schemaSql, /OLD\.tag_ids\s+IS DISTINCT FROM NEW\.tag_ids/);
  assert.doesNotMatch(schemaSql, /OLD\.tag_new/);
  assert.match(schemaSql, /NEW\.cover43/);
});

test("mission backfill advances through eligible AIDs in bounded batches", async () => {
  const backfillCursors: unknown[] = [];
  const batches = [
    Array.from({ length: 10_000 }, (_, index) => ({ aid: String(index + 1) })),
    Array.from({ length: 10_000 }, (_, index) => ({
      aid: String(index + 10_001),
    })),
    Array.from({ length: 5_000 }, (_, index) => ({
      aid: String(index + 20_001),
    })),
  ];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("WITH candidates AS")) {
        backfillCursors.push(values?.[0]);
        const rows = batches.shift() ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await backfillMissionIds(pool);

  assert.deepEqual(backfillCursors, [null, "10000", "20000", "25000"]);
  assert.equal(batches.length, 0);
});
