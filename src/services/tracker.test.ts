import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import axios from "axios";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import { StateManager } from "../core/state";
import type { BiliDynamicCard } from "../types";
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
