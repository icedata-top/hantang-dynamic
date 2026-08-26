import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../database";
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
  let persisted: { video: VideoData; filtered: boolean } | undefined;
  database.markVideoProcessedWithCollectionState = async (
    persistedVideo,
    filtered,
  ) => {
    persisted = { video: persistedVideo, filtered };
  };

  try {
    const service = new DetailsService();
    const processResolved = Reflect.get(service, "processResolvedVideoData");
    assert.equal(typeof processResolved, "function");
    const result = await Reflect.apply(processResolved, service, [
      video,
      [],
      { processRecommendations: false, processRelated: false },
    ]);

    assert.equal((result as ProcessedVideoResult).video, video);
    assert.deepEqual(persisted, { video, filtered: true });
  } finally {
    database.markVideoProcessedWithCollectionState = originalPersist;
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
