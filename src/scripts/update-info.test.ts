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
  readonly pidV2ByAid = new Map<number, number>();
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
      .filter((aid) => !options.onlyMissingPidV2 || !this.pidV2ByAid.has(aid))
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
    for (const item of items) {
      if (item.pidV2 !== undefined) {
        this.pidV2ByAid.set(Number(item.aid), item.pidV2);
      }
    }
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

test("concurrent collectors share twenty slots for source and admission requests", async () => {
  const database = new FakeDatabase([]);
  let active = 0;
  let maximum = 0;
  let admissionRequests = 0;
  const fetchDetail = async (id: string | number) => {
    const aid = Number(id);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (aid >= 1_000) admissionRequests++;
    return detail(aid, 100, aid < 1_000 ? [related(aid + 1_000, 7)] : []);
  };
  const service = () =>
    new RecommendationRefreshService({
      database,
      detailsService: parser,
      pidV2Whitelist: new Set([7]),
      fetchDetail,
    });
  await Promise.all(
    [service(), service()].map((collector, offset) =>
      collector.collectForAids(
        Array.from({ length: 25 }, (_, index) => ({
          aid: BigInt(offset * 100 + index + 1),
        })),
      ),
    ),
  );
  assert.equal(maximum, 20);
  assert.equal(admissionRequests, 50);
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
      if (aid === 2) return detail(2, 100, [related(1, 7), related(3, 7)]);
      if (aid === 3) return detail(3, 100, [related(4, 7)]);
      throw new Error(`unexpected recursive fetch ${aid}`);
    },
  });
  assert.equal(result.imported, 1);
  assert.equal(fetched.includes(4), false);
  assert.equal(database.pidV2ByAid.get(1), 7);
});

test("partial related cards refresh only their supplied existing fields", async () => {
  const database = new FakeDatabase([1, 2], new Set([1, 2]));
  let refreshed: ProcessedVideoRecommendationRefresh | undefined;
  database.refreshProcessedVideosFromRecommendations = async (items) => {
    refreshed = items[0];
    return items.length;
  };
  const partial = { aid: 2, desc: "", pid_v2: 7 } as RecommendedVideo;
  const service = new RecommendationRefreshService({
    database,
    detailsService: parser,
    pidV2Whitelist: new Set(),
    rateLimiter: {
      async acquire() {
        return () => {};
      },
    },
    fetchDetail: async () => detail(1, 100, [partial]),
  });
  await service.collectForAids([{ aid: 1n }]);
  assert.deepEqual(refreshed, { aid: 2n, description: "", pidV2: 7 });
});

test("whitelist parser rejects malformed explicit values", () => {
  assert.deepEqual(parsePidV2Whitelist(undefined), new Set());
  assert.deepEqual(parsePidV2Whitelist("7, 11"), new Set([7, 11]));
  assert.throws(() => parsePidV2Whitelist("7,,11"), /Invalid pid_v2/);
});
