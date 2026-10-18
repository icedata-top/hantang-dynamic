import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import axios from "axios";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import { StateManager } from "../core/state";
import type { BiliDynamicCard, VideoData } from "../types";
import type { RelatedVideoWorkItem } from "./details.service";
import { DynamicTracker } from "./tracker";

test("only a completed mixed scan persists an account's frontier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hantang-frontier-"));
  const path = join(directory, "state_7.json");
  // Legacy progress covers category 8 only, even when stored as a scalar.
  writeFileSync(
    path,
    JSON.stringify({
      lastDynamicId: "1000",
      lastDynamicIdByType: { 8: "1000" },
    }),
  );
  const stateManager = new StateManager(path);
  let fail = true;
  const client = axios.create({
    adapter: async (request) => {
      if (request.params.offset && fail) throw new Error("page unavailable");
      return {
        data: {
          code: 0,
          data: {
            items: ["DYNAMIC_TYPE_WORD", "DYNAMIC_TYPE_AV"].map(
              (type, index) => ({
                id_str: String(
                  (request.params.offset ? 800 : 900) - index * 50,
                ),
                type,
                modules: {
                  module_author: {
                    mid: 7,
                    name: "author",
                    pub_ts: String(Math.floor(Date.now() / 1000)),
                  },
                },
              }),
            ),
            offset: "next",
            has_more: !request.params.offset,
          },
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    },
  });
  const tracker = new DynamicTracker({
    uid: "7",
    stateManager,
    dynamicClient: client,
  } as AccountContext);
  const savedIds: string[] = [];
  Reflect.set(tracker, "detailsService", {
    saveDynamic: async (card: BiliDynamicCard) => {
      savedIds.push(card.desc.dynamic_id_str);
    },
    processVideo: async () => ({ video: null, relatedVideos: [] }),
  });
  const check = () =>
    Reflect.apply(
      Reflect.get(tracker, "checkDynamics"),
      tracker,
      [],
    ) as Promise<void>;
  const originalWait = config.application.apiWaitTime;
  config.application.apiWaitTime = 0;
  try {
    assert.equal(stateManager.lastFeedDynamicId, 0n);
    await assert.rejects(check(), /page unavailable/);
    assert.equal(new StateManager(path).lastFeedDynamicId, 0n);
    assert.deepEqual(savedIds, ["900", "850"]);
    fail = false;
    await check();
    assert.deepEqual(savedIds, ["900", "850", "900", "850", "800", "750"]);
    assert.equal(new StateManager(path).lastFeedDynamicId, 900n);
  } finally {
    config.application.apiWaitTime = originalWait;
    rmSync(directory, { recursive: true, force: true });
  }
});

const retryVideo = {
  aid: 42n,
  bvid: "BV1retry",
  user_id: 7n,
  type_id: 3,
  title: "retried video",
  description: "",
  pic: "",
  tag: "",
  pubdate: 1_700_000_000,
  ctime: 1_700_000_000,
} as VideoData;

function retryTracker(detailsService: object) {
  const directory = mkdtempSync(join(tmpdir(), "hantang-retry-"));
  const tracker = new DynamicTracker({
    uid: "7",
    stateManager: new StateManager(join(directory, "state_7.json")),
  } as AccountContext);
  Reflect.set(tracker, "detailsService", detailsService);
  return { tracker, directory };
}

const retryCandidate = {
  dynamic: {
    desc: { type: 8, bvid: "BV1retry", rid: 42 },
  },
} as unknown as RelatedVideoWorkItem;

test("failed work items exhaust their attempt budget inside the run", async () => {
  let attempts = 0;
  const { tracker, directory } = retryTracker({
    processVideo: async () => {
      attempts++;
      return { video: null, relatedVideos: [], failed: true };
    },
  });

  const originalWait = config.application.apiWaitTime;
  const originalRetries = config.application.apiRetryTimes;
  config.application.apiWaitTime = 50;
  config.application.apiRetryTimes = 3;

  try {
    Reflect.apply(Reflect.get(tracker, "enqueueRetry"), tracker, [
      retryCandidate,
      0,
      false,
      new Set<string>(),
    ]);
    await Reflect.apply(Reflect.get(tracker, "flushRetries"), tracker, []);

    assert.equal(attempts, 3);
    const pending = Reflect.get(tracker, "pendingRetries") as Map<
      string,
      unknown
    >;
    assert.equal(pending.size, 0);
  } finally {
    config.application.apiWaitTime = originalWait;
    config.application.apiRetryTimes = originalRetries;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovered retries keep the traversal's seen candidates", async () => {
  const related = {
    dynamic: {
      desc: { type: 8, bvid: "BV1related", rid: 43 },
    },
  } as unknown as RelatedVideoWorkItem;
  const { tracker, directory } = retryTracker({
    processVideo: async () => ({
      video: retryVideo,
      relatedVideos: [related],
      failed: false,
    }),
  });
  const seen = new Set(["bvid:BV1retry"]);
  const calls: unknown[][] = [];
  Reflect.set(tracker, "processPage", async (...args: unknown[]) => {
    calls.push(args);
    return [];
  });

  const originalWait = config.application.apiWaitTime;
  const originalRetries = config.application.apiRetryTimes;
  config.application.apiWaitTime = 0;
  config.application.apiRetryTimes = 2;

  try {
    Reflect.apply(Reflect.get(tracker, "enqueueRetry"), tracker, [
      retryCandidate,
      0,
      true,
      seen,
    ]);
    await Reflect.apply(Reflect.get(tracker, "flushRetries"), tracker, []);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1], 1);
    assert.equal(calls[0]?.[2], seen);
    assert.equal(seen.has("bvid:BV1related"), false);
  } finally {
    config.application.apiWaitTime = originalWait;
    config.application.apiRetryTimes = originalRetries;
    rmSync(directory, { recursive: true, force: true });
  }
});
