import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProcessedVideoBatchItem,
  ProcessedVideoRecommendationRefresh,
} from "../database/index.js";
import { RecommendationRefreshService } from "../services/recommendation-refresh.service.js";
import type {
  BiliVideoFullDetailResponse,
  RecommendedVideo,
  VideoData,
} from "../types/index.js";
import { parsePidV2Whitelist, runUpdateInfo } from "./update-info.js";

function related(aid: number, pid_v2?: number): RecommendedVideo {
  return {
    aid,
    bvid: `BV${aid}`,
    cid: aid,
    title: `related-${aid}`,
    pic: `pic-${aid}`,
    desc: `desc-${aid}`,
    tid: 3,
    tname: "",
    duration: 1,
    pubdate: 1,
    owner: { mid: aid, name: "", face: "" },
    stat: {
      aid,
      view: 1,
      coin: 0,
      danmaku: 0,
      favorite: 0,
      like: 0,
      reply: 0,
      share: 0,
    },
    ...(pid_v2 === undefined ? {} : { pid_v2 }),
  };
}
function detail(
  aid: number,
  views: number,
  Related: RecommendedVideo[] = [],
): BiliVideoFullDetailResponse {
  return {
    code: 0,
    message: "",
    ttl: 1,
    data: {
      View: {
        aid: BigInt(aid),
        bvid: `BV${aid}`,
        cid: aid,
        title: `full-${aid}`,
        desc: "",
        pic: "",
        pubdate: 1,
        ctime: 1,
        owner: { mid: BigInt(aid) },
        stat: { view: views },
      },
      Related,
    },
  } as unknown as BiliVideoFullDetailResponse;
}
function video(aid: number): VideoData {
  return {
    aid: BigInt(aid),
    bvid: `BV${aid}`,
    user_id: BigInt(aid),
    type_id: 3,
    title: `full-${aid}`,
    description: "",
    pic: "",
    tag: "",
    pubdate: 1,
  };
}
class FakeDatabase {
  closed = false;
  calls = { membership: 0, refresh: 0, persist: 0 };
  constructor(
    readonly sources: number[],
    readonly existing = new Set(sources),
  ) {}
  async init() {}
  async close() {
    this.closed = true;
  }
  async getProcessedVideoMetadataUpperAid() {
    return BigInt(Math.max(...this.sources));
  }
  async getProcessedVideoMetadataCandidates(options: {
    afterAid: bigint;
    onlyMissingPidV2?: boolean;
  }) {
    return this.sources
      .filter((aid) => BigInt(aid) > options.afterAid)
      .map((aid) => ({ aid: BigInt(aid), bvid: `BV${aid}` }));
  }
  async getProcessedVideoAids(aids: readonly bigint[]) {
    this.calls.membership++;
    return new Set(aids.filter((aid) => this.existing.has(Number(aid))));
  }
  async refreshProcessedVideosFromRecommendations(
    items: readonly ProcessedVideoRecommendationRefresh[],
  ) {
    this.calls.refresh++;
    return items.length;
  }
  async markVideosProcessedWithCollectionState(
    items: readonly ProcessedVideoBatchItem[],
  ) {
    this.calls.persist++;
    for (const item of items) this.existing.add(Number(item.video.aid));
    return items.length;
  }
}
const parser = {
  async processVideoDetailResponse(detailData: { View: { aid: bigint } }) {
    return { videoData: video(Number(detailData.View.aid)) };
  },
};

test("collector uses one bounded membership and refresh path while admitting only whitelisted related videos", async () => {
  const database = new FakeDatabase([1], new Set([1, 2]));
  const service = new RecommendationRefreshService({
    database,
    detailsService: parser,
    pidV2Whitelist: new Set([7]),
    rateLimiter: {
      async acquire() {
        return () => {};
      },
    },
    fetchDetail: async (id) =>
      detail(
        Number(id),
        100,
        Number(id) === 1 ? [related(2), related(3, 7), related(4, 8)] : [],
      ),
  });
  const result = await service.collectForAids([{ aid: 1n }]);
  assert.equal(result.metadataUpdated, 1);
  assert.equal(result.imported, 1);
  assert.deepEqual([...database.existing].sort(), [1, 2, 3]);
  assert.deepEqual(database.calls, { membership: 1, refresh: 1, persist: 1 });
});

test("collector caps more than twenty source requests at twenty", async () => {
  const database = new FakeDatabase([]);
  let active = 0;
  let maximum = 0;
  const service = new RecommendationRefreshService({
    database,
    detailsService: parser,
    pidV2Whitelist: new Set(),
    fetchDetail: async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return detail(Number(id), 0);
    },
  });
  await service.collectForAids(
    Array.from({ length: 25 }, (_, index) => ({ aid: BigInt(index + 1) })),
  );
  assert.equal(maximum, 20);
  assert.equal(database.calls.membership, 1);
});

test("manual updater preserves the original AID cutoff and closes the database", async () => {
  const database = new FakeDatabase([1, 2]);
  const result = await runUpdateInfo({
    database,
    detailsService: parser,
    pidV2Whitelist: new Set(),
    onProgress: () => {},
    fetchDetail: async (id) => detail(Number(String(id).replace("BV", "")), 10),
  });
  assert.equal(result.scanned, 2);
  assert.equal(database.closed, true);
});

test("manual reverse fill stops after one bridge layer", async () => {
  const database = new FakeDatabase([1]);
  const fetched: number[] = [];
  const result = await runUpdateInfo({
    database,
    detailsService: parser,
    pidV2Whitelist: new Set([7]),
    onProgress: () => {},
    fetchDetail: async (id) => {
      const aid = Number(String(id).replace("BV", ""));
      fetched.push(aid);
      if (aid === 1) return detail(1, 100, [related(2, 99)]);
      if (aid === 2) return detail(2, 100, [related(3, 7)]);
      if (aid === 3) return detail(3, 100, [related(4, 7)]);
      throw new Error(`unexpected recursive fetch ${aid}`);
    },
  });
  assert.equal(result.imported, 1);
  assert.equal(fetched.includes(4), false);
});

test("whitelist parser rejects malformed explicit values", () => {
  assert.deepEqual(parsePidV2Whitelist(undefined), new Set());
  assert.deepEqual(parsePidV2Whitelist("7, 11"), new Set([7, 11]));
  assert.throws(() => parsePidV2Whitelist("7,,11"), /Invalid pid_v2/);
});
