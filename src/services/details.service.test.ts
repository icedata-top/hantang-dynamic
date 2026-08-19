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
