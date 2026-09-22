import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { VideoData } from "../types/models/video.js";
import { upgradeVideoHistoryTagIdentitySchema } from "./schema/video_history";
import { backfillMissionIds } from "./schema/videos";
import {
  getProcessedVideoAids,
  getProcessedVideoAidsMissingPidV2,
  getProcessedVideoMetadataCandidates,
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

test("authoritative TAG snapshots update the processed video and dictionary transaction", async () => {
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
  assert.match(
    calls[3]?.sql ?? "",
    /fn_upsert_collection_state_from_processed_video/,
  );
  assert.equal(calls[4]?.sql, "COMMIT");
});

test("missing TAG snapshots preserve stored names and TAG IDs", async () => {
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
});

test("authoritative empty TAG snapshots clear names and TAG IDs", async () => {
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

test("missing pid lookup queries only a bounded AID set", async () => {
  const calls: QueryCall[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ aid: "2" }], rowCount: 1 };
    },
  } as unknown as Pool;

  const missing = await getProcessedVideoAidsMissingPidV2(pool, [1n, 2n]);

  assert.deepEqual(missing, new Set([2n]));
  assert.match(calls[0]?.sql ?? "", /aid = ANY\(\$1::bigint\[\]\)/);
  assert.match(calls[0]?.sql ?? "", /pid_v2 IS NULL/);
  assert.deepEqual(calls[0]?.values, [["1", "2"]]);
});

test("metadata candidates combine a raw predicate with existing bounds", async () => {
  const calls: QueryCall[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const createdBefore = new Date("2026-09-22T00:00:00Z");

  await getProcessedVideoMetadataCandidates(pool, {
    afterAid: 2_746_490n,
    throughAid: 9_999_999n,
    createdBefore,
    onlyMissingPidV2: false,
    where: "aid >= 2746491 OR pid_v2 IS NULL",
    limit: 100,
  });

  assert.match(calls[0]?.sql ?? "", /AND \(aid >= 2746491 OR pid_v2 IS NULL\)/);
  assert.match(calls[0]?.sql ?? "", /aid > \$1::bigint/);
  assert.match(
    calls[0]?.sql ?? "",
    /\(\$4::boolean = false OR pid_v2 IS NULL\)/,
  );
  assert.deepEqual(calls[0]?.values, [
    "2746490",
    "9999999",
    createdBefore,
    false,
    100,
  ]);
});

test("recommendation refresh deduplicates inputs and preserves absent card fields", async () => {
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
    bvid?: string;
    pid_v2?: number;
  }>;
  assert.equal(payload.length, 1);
  assert.equal(payload[0]?.bvid, "BVnew");
  assert.equal(payload[0]?.pid_v2, undefined);
  assert.match(
    calls[0]?.sql ?? "",
    /video\.title IS DISTINCT FROM COALESCE\(incoming\.title, video\.title\)/,
  );
  assert.match(calls[0]?.sql ?? "", /pid_v2 = COALESCE\(incoming\.pid_v2/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /is_filtered|notes|tag_ids/);
});

test("recommendation refresh accepts sparse cards without nulling stored basics", async () => {
  const calls: QueryCall[] = [];
  const query = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };

  await refreshProcessedVideosFromRecommendations(query as unknown as Pool, [
    { aid: 7n, description: "", pidV2: 9 },
  ]);

  const payload = JSON.parse(calls[0]?.values?.[0] as string) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(payload, [
    { aid: "7", description: "", cover43: null, pid_v2: 9 },
  ]);
  assert.match(
    calls[0]?.sql ?? "",
    /bvid = COALESCE\(incoming\.bvid, video\.bvid\)/,
  );
  assert.match(
    calls[0]?.sql ?? "",
    /description = COALESCE\(incoming\.description, video\.description\)/,
  );
});

test("recommendation refresh serializes PostgreSQL-safe Unicode", async () => {
  const calls: QueryCall[] = [];
  const query = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const title = "推荐\u0000\uD800😀";
  const originalPayload = JSON.stringify([{ aid: "7", title }]);

  await refreshProcessedVideosFromRecommendations(query as unknown as Pool, [
    { aid: 7n, title },
  ]);

  assert.match(originalPayload, /\\u0000/);
  assert.match(originalPayload, /\\ud800/);
  const payload = JSON.parse(calls[0]?.values?.[0] as string) as Array<{
    title: string;
  }>;
  assert.equal(payload[0]?.title, "推荐��😀");
});

test("single-detail writes sanitize text, arrays, and JSON metadata", async () => {
  const { pool, calls } = createPool();
  const unicodeVideo: VideoData = {
    ...video,
    title: "标题\u0000\uD800😀",
    dynamic: "动态\uDC00",
    tag_new: ["标签\uD800"],
    participle: ["词\uDC00"],
    extras: {
      argue_info: {
        argue_msg: "消息\u0000\uD800",
        argue_type: 1,
        argue_link: "https://example.test/😀",
      },
    },
    notes: { api_message: "备注\uDC00" },
  };

  await markVideoProcessedWithCollectionState(pool, unicodeVideo, true);

  const values = calls[1]?.values;
  assert.equal(values?.[3], "标题��😀");
  assert.equal(values?.[12], "动态�");
  assert.deepEqual(values?.[13], ["标签�"]);
  assert.deepEqual(values?.[14], ["词�"]);
  assert.deepEqual(JSON.parse(values?.[20] as string), {
    argue_info: {
      argue_msg: "消息��",
      argue_type: 1,
      argue_link: "https://example.test/😀",
    },
  });
  assert.deepEqual(JSON.parse(values?.[21] as string), {
    api_message: "备注�",
  });
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
  const unicodeCover = "https://cover/\u0000😀\\u0000";
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
    { aid: 2n, cover43: unicodeCover },
  ]);

  assert.equal(updated, 2);
  assert.deepEqual(calls[0]?.values, [
    ["1", "2"],
    [22, null],
    ["https://cover/1", "https://cover/�😀\\u0000"],
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
  assert.match(
    calls[3]?.sql ?? "",
    /fn_upsert_collection_state_from_processed_video/,
  );
  assert.equal(calls[4]?.sql, "COMMIT");
});

test("full-detail batch preserves valid Unicode and sanitizes nested JSON values and keys", async () => {
  const { pool, calls } = createPool();
  const unicodeVideo: VideoData = {
    ...video,
    title: "中文\n😀\u0000\uD800",
    description: "literal \\u0000",
    tagSnapshot: [{ tagId: 10n, tagName: "标签\u0000\uD800" }],
    extras: {
      "nested\u0000key": {
        message: "metadata\uD800",
        literal: "\\u0000",
        enabled: true,
        count: 3,
      },
    } as unknown as VideoData["extras"],
    notes: { api_message: "notes\uDC00" },
  };
  const originalPayload = JSON.stringify([
    {
      title: unicodeVideo.title,
      extras: unicodeVideo.extras,
      notes: unicodeVideo.notes,
    },
  ]);

  await markVideosProcessedWithCollectionState(pool, [
    { video: unicodeVideo, filtered: true },
  ]);

  assert.match(originalPayload, /\\u0000/);
  assert.match(originalPayload, /\\ud800/);
  const payload = JSON.parse(calls[1]?.values?.[0] as string) as Array<{
    title: string;
    description: string;
    tag_snapshot: Array<{ tagName: string }>;
    extras: Record<string, unknown>;
    notes: Record<string, unknown>;
  }>;
  assert.equal(payload[0]?.title, "中文\n😀��");
  assert.equal(payload[0]?.description, "literal \\u0000");
  assert.equal(payload[0]?.tag_snapshot[0]?.tagName, "标签��");
  assert.deepEqual(payload[0]?.extras, {
    "nested�key": {
      message: "metadata�",
      literal: "\\u0000",
      enabled: true,
      count: 3,
    },
  });
  assert.deepEqual(payload[0]?.notes, { api_message: "notes�" });
});

test("full-detail batch rejects metadata keys that collide after Unicode normalization", async () => {
  const { pool, calls } = createPool();
  const collisionVideo: VideoData = {
    ...video,
    extras: {
      "\u0000": 1,
      "�": 2,
    } as unknown as VideoData["extras"],
  };

  await assert.rejects(
    markVideosProcessedWithCollectionState(pool, [
      { video: collisionVideo, filtered: true },
    ]),
    /JSON object keys collide after Unicode normalization/,
  );

  assert.equal(calls.length, 0);
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
