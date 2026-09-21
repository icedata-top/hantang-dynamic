import assert from "node:assert/strict";
import test from "node:test";
import type {
  BiliVideoFullDetailResponse,
  RecommendedVideo,
} from "../types/index.js";
import { parsePidV2Whitelist, runUpdateInfo } from "./update-info.js";

function related(
  aid: number,
  pidV2?: number,
  cover43?: string,
): RecommendedVideo {
  return {
    aid,
    bvid: `BV${aid}`,
    cid: aid,
    cover43,
    owner: { mid: aid, name: "owner", face: "face" },
    pic: `pic-${aid}`,
    pubdate: 0,
    stat: {
      aid,
      coin: 0,
      danmaku: 0,
      favorite: 0,
      like: 0,
      reply: 0,
      share: 0,
      view: 100,
    },
    title: `video-${aid}`,
    ...(pidV2 === undefined ? {} : { pid_v2: pidV2 }),
  } as RecommendedVideo;
}

function detail(
  aid: number,
  views: number | undefined,
  Related: RecommendedVideo[] = [],
): BiliVideoFullDetailResponse {
  return {
    code: 0,
    data: {
      Related,
      View: { aid: BigInt(aid), stat: { view: views } },
    },
    message: "0",
    ttl: 1,
  } as unknown as BiliVideoFullDetailResponse;
}

function numericAid(id: string | number): number {
  return typeof id === "number" ? id : Number(id.replace(/^BV/, ""));
}

class FakeDatabase {
  closed = false;
  initialized = false;
  readonly imported = new Set<number>();
  readonly sweeps: Array<{ afterAid: bigint; throughAid: bigint }> = [];

  constructor(
    private readonly sourceAids: number[],
    private readonly pidByAid = new Map<number, number | undefined>(),
  ) {}

  async init() {
    this.initialized = true;
  }

  async close() {
    this.closed = true;
  }

  async getProcessedVideoMetadataUpperAid() {
    return BigInt(Math.max(...this.sourceAids));
  }

  async getProcessedVideoMetadataCandidates(options: {
    afterAid: bigint;
    onlyMissingPidV2?: boolean;
    throughAid: bigint;
  }) {
    this.sweeps.push({
      afterAid: options.afterAid,
      throughAid: options.throughAid,
    });
    return this.sourceAids
      .filter((aid) => BigInt(aid) > options.afterAid)
      .filter(
        (aid) =>
          !options.onlyMissingPidV2 || this.pidByAid.get(aid) === undefined,
      )
      .map((aid) => ({
        aid: BigInt(aid),
        bvid: "",
        pidV2: this.pidByAid.get(aid),
      }));
  }

  async hasProcessedVideoById(aid: number) {
    return this.sourceAids.includes(aid) || this.imported.has(aid);
  }

  applyMetadata(items: RecommendedVideo[]) {
    for (const item of items) {
      if (
        this.sourceAids.includes(item.aid) &&
        typeof item.pid_v2 === "number"
      ) {
        this.pidByAid.set(item.aid, item.pid_v2);
      }
    }
  }
}

test("manual updater sweeps original sources in AID order and requires actual views", async () => {
  const database = new FakeDatabase([2, 9]);
  const fetched: number[] = [];
  const metadata: number[][] = [];
  const result = await runUpdateInfo({
    database,
    detailsService: {
      async enrichRelatedVideoMetadata(items) {
        metadata.push(items.map((item) => item.aid));
        database.applyMetadata(items);
        return items.length;
      },
      async processFetchedVideoDetail() {
        throw new Error("no imports expected");
      },
    },
    fetchDetail: async (id) => {
      const aid = numericAid(id);
      fetched.push(aid);
      return aid === 2
        ? detail(aid, 11, [related(20, 7)])
        : detail(aid, 10, [related(21, 7)]);
    },
    onProgress: () => {},
    pidV2Whitelist: new Set(),
  });

  assert.deepEqual(fetched.slice(0, 2), [2, 9]);
  assert.deepEqual(database.sweeps[0], { afterAid: 0n, throughAid: 9n });
  assert.deepEqual(metadata, [[20]]);
  assert.equal(result.scanned, 2);
  assert.equal(database.closed, true);
});

test("bridge reverse fill imports only allowed recommendations and stops after one layer", async () => {
  const database = new FakeDatabase([1]);
  const imported: Array<{ aid: number; pidV2?: number; cover43?: string }> = [];
  const fetched: number[] = [];
  const result = await runUpdateInfo({
    database,
    detailsService: {
      async enrichRelatedVideoMetadata(items) {
        database.applyMetadata(items);
        return items.length;
      },
      async processFetchedVideoDetail(aid, _detail, options) {
        database.imported.add(aid);
        imported.push({ aid, pidV2: options.pidV2, cover43: options.cover43 });
        return { video: {} };
      },
    },
    fetchDetail: async (id) => {
      const aid = numericAid(id);
      fetched.push(aid);
      if (aid === 1) return detail(1, 50, [related(2, 99)]);
      if (aid === 2)
        return detail(2, 50, [
          related(1, 7, "cover-a"),
          related(3, 7, "cover-c"),
        ]);
      if (aid === 3) return detail(3, 50, [related(4, 7)]);
      throw new Error(`unexpected recursive fetch ${aid}`);
    },
    onProgress: () => {},
    pidV2Whitelist: new Set([7]),
  });

  assert.deepEqual(imported, [{ aid: 3, pidV2: 7, cover43: "cover-c" }]);
  assert.equal(fetched.includes(4), false);
  assert.equal(result.unresolved, 0);
  assert.equal(result.imported, 1);
});

test("unavailable details continue, while database failures are not reported as success", async () => {
  const database = new FakeDatabase([1, 2]);
  const result = await runUpdateInfo({
    database,
    detailsService: {
      async enrichRelatedVideoMetadata() {
        return 0;
      },
      async processFetchedVideoDetail() {
        return { video: null };
      },
    },
    fetchDetail: async (id) => {
      const aid = numericAid(id);
      return aid === 1 ? null : detail(aid, 1);
    },
    onProgress: () => {},
    pidV2Whitelist: new Set(),
  });
  assert.equal(result.errors, 1);
  assert.equal(result.scanned, 2);

  const brokenDatabase = new FakeDatabase([1]);
  brokenDatabase.getProcessedVideoMetadataUpperAid = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(
    runUpdateInfo({
      database: brokenDatabase,
      detailsService: {} as never,
      onProgress: () => {},
      pidV2Whitelist: new Set(),
    }),
    /database unavailable/,
  );
  assert.equal(brokenDatabase.closed, true);
});

test("whitelist parser rejects malformed explicit values", () => {
  assert.deepEqual(parsePidV2Whitelist(undefined), new Set());
  assert.deepEqual(parsePidV2Whitelist("7, 11"), new Set([7, 11]));
  assert.throws(() => parsePidV2Whitelist("7,,11"), /Invalid pid_v2/);
  assert.throws(() => parsePidV2Whitelist("tid=7"), /Invalid pid_v2/);
});
