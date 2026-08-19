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

test("newly processed eligible videos upsert collection state after persistence", async () => {
  const database = Database.getInstance();
  const originalMarkVideoProcessed = database.markVideoProcessed;
  const originalUpsertCollectionState =
    database.upsertCollectionStateFromProcessedVideo;
  const calls: string[] = [];
  let collectionInput: unknown;
  database.markVideoProcessed = async () => {
    calls.push("processed");
  };
  database.upsertCollectionStateFromProcessedVideo = async (input) => {
    calls.push("collection-state");
    collectionInput = input;
    return "upserted_bootstrap";
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
    assert.deepEqual(calls, ["processed", "collection-state"]);
    assert.deepEqual(collectionInput, {
      aid: 42n,
      pubdate: 1_700_000_000,
      ctime: 1_700_000_000,
      tidV2: 2022,
      isDeleted: false,
      isFiltered: true,
    });
  } finally {
    database.markVideoProcessed = originalMarkVideoProcessed;
    database.upsertCollectionStateFromProcessedVideo =
      originalUpsertCollectionState;
  }
});

test("authoritative deleted and unavailable detail results disable active minute collection", async () => {
  const database = Database.getInstance();
  const originalMarkVideoDeleted = database.markVideoDeleted;
  const calls: string[] = [];
  database.markVideoDeleted = async (bvid) => {
    calls.push(`deleted:${bvid}`);
    return 42n;
  };
  Reflect.set(
    database,
    "disableDeletedVideoCollectionState",
    async (aid: bigint) => {
      calls.push(`disabled:${aid}`);
    },
  );

  try {
    const service = new DetailsService();
    for (const [code, expectedBvid] of [
      [404, "BV1deleted"],
      [-404, "BV1negativeDeleted"],
      [62002, "BV1invisible"],
      [62004, "BV1review"],
      [62012, "BV1private"],
    ] as const) {
      await service.processVideoApiCode(expectedBvid, code, "unavailable");
    }

    assert.deepEqual(calls, [
      "deleted:BV1deleted",
      "disabled:42",
      "deleted:BV1negativeDeleted",
      "disabled:42",
      "deleted:BV1invisible",
      "disabled:42",
      "deleted:BV1review",
      "disabled:42",
      "deleted:BV1private",
      "disabled:42",
    ]);
  } finally {
    database.markVideoDeleted = originalMarkVideoDeleted;
    Reflect.deleteProperty(database, "disableDeletedVideoCollectionState");
  }
});
