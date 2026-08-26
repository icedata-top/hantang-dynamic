import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../database";
import type {
  BiliVideoDetailDataForProcessing,
  RecommendedVideo,
} from "../types/bilibili/video";
import type { VideoData } from "../types/models/video";
import { DetailsService } from "./details.service";

const video: VideoData = {
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

interface ProcessedVideoResult {
  video: VideoData | null;
}

test("newly processed eligible videos persist with collection state", async () => {
  const database = Database.getInstance();
  const originalPersist = database.markVideoProcessedWithCollectionState;
  const originalPidV2Update = database.updateProcessedVideoPidV2;
  let persisted: { video: VideoData; filtered: boolean } | undefined;
  let relatedMetadata: ReadonlyArray<{ aid: bigint; pidV2: number }> = [];
  database.markVideoProcessedWithCollectionState = async (
    persistedVideo,
    filtered,
  ) => {
    persisted = { video: persistedVideo, filtered };
  };
  database.updateProcessedVideoPidV2 = async (metadata) => {
    relatedMetadata = metadata;
    return metadata.length;
  };

  try {
    const service = new DetailsService();
    const processResolved = Reflect.get(service, "processResolvedVideoData");
    assert.equal(typeof processResolved, "function");
    const result = await Reflect.apply(processResolved, service, [
      video,
      [{ aid: 50, pid_v2: 33 } as RecommendedVideo],
      { processRecommendations: false, processRelated: false },
    ]);

    assert.equal((result as ProcessedVideoResult).video, video);
    assert.deepEqual(persisted, { video, filtered: true });
    assert.deepEqual(relatedMetadata, [{ aid: 50n, pidV2: 33 }]);
  } finally {
    database.markVideoProcessedWithCollectionState = originalPersist;
    database.updateProcessedVideoPidV2 = originalPidV2Update;
  }
});

test("authoritative detail results carry BVID and AID identities to terminal persistence", async () => {
  const database = Database.getInstance();
  const originalMarkVideoDeleted = database.markVideoDeleted;
  const identities: unknown[] = [];
  database.markVideoDeleted = async (identity) => {
    identities.push(identity);
    return 42n;
  };

  try {
    const service = new DetailsService();
    const authoritativeCodes = [404, -404, 62002, 62004, 62012];
    for (const code of authoritativeCodes) {
      await service.processVideoApiCode(
        "BV1authoritative",
        code,
        "unavailable",
      );
      await service.processVideoApiCode(
        113_646_663_373_638,
        code,
        "unavailable",
      );
    }

    assert.deepEqual(identities, [
      { type: "bvid", bvid: "BV1authoritative" },
      { type: "aid", aid: 113_646_663_373_638n },
      { type: "bvid", bvid: "BV1authoritative" },
      { type: "aid", aid: 113_646_663_373_638n },
      { type: "bvid", bvid: "BV1authoritative" },
      { type: "aid", aid: 113_646_663_373_638n },
      { type: "bvid", bvid: "BV1authoritative" },
      { type: "aid", aid: 113_646_663_373_638n },
      { type: "bvid", bvid: "BV1authoritative" },
      { type: "aid", aid: 113_646_663_373_638n },
    ]);
  } finally {
    database.markVideoDeleted = originalMarkVideoDeleted;
  }
});

test("non-authoritative API codes do not enter terminal persistence", async () => {
  const database = Database.getInstance();
  const originalMarkVideoDeleted = database.markVideoDeleted;
  let markedDeleted = false;
  database.markVideoDeleted = async () => {
    markedDeleted = true;
    return 42n;
  };

  try {
    const service = new DetailsService();
    await assert.rejects(
      service.processVideoApiCode("BV1transient", -412, "risk control"),
      /API Error: code -412/,
    );
    assert.equal(markedDeleted, false);
  } finally {
    database.markVideoDeleted = originalMarkVideoDeleted;
  }
});

test("detail metadata retains recognized ordinary and topic TAGs", async () => {
  const service = new DetailsService();
  const detailData = {
    View: {
      aid: 42n,
      bvid: "BV1test",
      owner: { mid: 7n },
      tid: 3,
      title: "video",
      desc: "",
      dynamic: "",
      pic: "",
      pubdate: 1,
      ctime: 1,
      copyright: 1,
      duration: 1,
      videos: 1,
      state: 0,
      cid: 1,
      mission_id: 99,
    },
    Card: { card: {} },
    Tags: [
      { tag_id: 10, tag_name: "ordinary" },
      { tag_id: 11, tag_name: "channel", tag_type: "old_channel" },
      { tag_id: 12, tag_name: "topic", tag_type: "topic" },
      { tag_id: 20, tag_name: "song", tag_type: "bgm" },
      { tag_id: 30, tag_name: "future", tag_type: "future_type" },
      { tag_id: 0, tag_name: "legacy-name" },
    ],
  } as unknown as BiliVideoDetailDataForProcessing;

  const { videoData } = await service.processVideoDetailResponse(detailData, {
    storeOwner: false,
  });

  assert.equal(videoData.mission_id, 99n);
  assert.equal(videoData.tag, "ordinary;channel;topic;legacy-name");
  assert.deepEqual(videoData.tag_new, [
    "ordinary",
    "channel",
    "topic",
    "legacy-name",
  ]);
  assert.deepEqual(videoData.tagSnapshot, [
    { tagId: 10n, tagName: "ordinary" },
    { tagId: 11n, tagName: "channel" },
    { tagId: 12n, tagName: "topic" },
  ]);
});

test("missing or malformed detail TAG arrays do not create authoritative relations", async () => {
  const service = new DetailsService();
  const base = {
    View: {
      aid: 42n,
      bvid: "BV1test",
      owner: { mid: 7n },
      tid: 3,
      title: "video",
      desc: "",
      dynamic: "",
      pic: "",
      pubdate: 1,
      ctime: 1,
      copyright: 1,
      duration: 1,
      videos: 1,
      state: 0,
      cid: 1,
    },
    Card: { card: {} },
  };
  for (const Tags of [
    undefined,
    [{ tag_name: "missing identity" }],
    [{ tag_id: 20, tag_type: "bgm" }],
  ]) {
    const { videoData } = await service.processVideoDetailResponse(
      { ...base, Tags } as unknown as BiliVideoDetailDataForProcessing,
      { storeOwner: false },
    );
    assert.equal(videoData.tagSnapshot, undefined);
    assert.equal(videoData.mission_id, undefined);
  }
});

test("an empty detail TAG array is an authoritative empty snapshot", async () => {
  const service = new DetailsService();
  const detailData = {
    View: {
      aid: 42n,
      bvid: "BV1test",
      owner: { mid: 7n },
      tid: 3,
      title: "video",
      desc: "",
      dynamic: "",
      pic: "",
      pubdate: 1,
      ctime: 1,
      copyright: 1,
      duration: 1,
      videos: 1,
      state: 0,
      cid: 1,
    },
    Card: { card: {} },
    Tags: [],
  } as unknown as BiliVideoDetailDataForProcessing;

  const { videoData } = await service.processVideoDetailResponse(detailData, {
    storeOwner: false,
  });

  assert.equal(videoData.tag, "");
  assert.deepEqual(videoData.tag_new, []);
  assert.deepEqual(videoData.tagSnapshot, []);
});
