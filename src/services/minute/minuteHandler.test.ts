import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import { config } from "../../config";
import type { AccountContext } from "../../core/account";
import type { StateManager } from "../../core/state";
import type { WatchLaterAccount } from "../../database/watchLater";
import type {
  CompleteVideoMinuteTuple,
  VideoMinuteSample,
} from "../../types/models/minute";
import { type MinuteDatabase, MinuteHandler } from "./minuteHandler";
import { runAutomaticWatchLaterManagement } from "./watchLaterReconciliation";

const configuredAccount: WatchLaterAccount = {
  accountId: 7n,
  configuredCapacity: 0,
  targetCount: 1,
  remoteCapacity: null,
  capacityBlockedAt: null,
  lastCompleteSnapshotAt: null,
};

function sample(aid: bigint, view = 10): VideoMinuteSample {
  return {
    aid,
    time: new Date("2026-08-18T00:00:00Z"),
    coin: 1,
    favorite: 1,
    danmaku: 1,
    view,
    reply: 1,
    share: 1,
    like: 1,
  };
}

function complete(aid: bigint): CompleteVideoMinuteTuple {
  return {
    aid,
    time: new Date("2026-08-18T00:00:00Z"),
    coin: 1,
    favorite: 1,
    danmaku: 1,
    view: 10,
    reply: 1,
    share: 1,
    like: 1,
  };
}

function database(calls: string[]): MinuteDatabase {
  return {
    async advanceFailedMinuteVideos(aids) {
      calls.push(`failed:${aids.join(",")}`);
      return aids.length;
    },
    async advanceUnchangedMinuteVideos(aids) {
      calls.push(`unchanged:${aids.join(",")}`);
      return aids.length;
    },
    async getConfiguredWatchLaterAccounts() {
      calls.push("configured-accounts");
      return [configuredAccount];
    },
    async getEnabledWatchLaterAccounts() {
      calls.push("enabled-accounts");
      return [];
    },
    async getDesiredWatchLaterSet() {
      return { aids: [], mandatoryCount: 0, overflow: false };
    },
    async getWatchLaterOwnedAids() {
      return [];
    },
    async getRecoverableWatchLaterOperations() {
      return [];
    },
    async createWatchLaterOperation() {},
    async recordWatchLaterOperationAttempt() {
      return true;
    },
    async resolveWatchLaterOperation() {
      return true;
    },
    async removeWatchLaterOwnershipAfterCompleteSnapshot() {
      return 0;
    },
    async recordWatchLaterCompleteSnapshot() {},
    async withWatchLaterAccountLease<T>(
      _accountId: bigint,
      callback: () => Promise<T>,
    ) {
      return callback();
    },
    async getLatestCompleteVideoMinuteTuple() {
      return null;
    },
    async getNextMinuteDueAt() {
      return null;
    },
    async insertVideoMinuteSamples(samples) {
      calls.push(`insert:${samples.map((item) => item.aid).join(",")}`);
      return samples.length;
    },
    async selectDueMinuteVideos() {
      return [];
    },
  };
}

test("MinuteHandler processes initial, changed, unchanged, malformed, and duplicate tuples through its production method", async () => {
  const calls: string[] = [];
  const handler = new MinuteHandler({
    database: database(calls),
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [
        sample(1n),
        sample(2n, 20),
        { ...sample(3n), favorite: undefined },
        sample(2n, 21),
      ];
    },
  });
  await handler.processBatch([
    { aid: 1n, lastView: null },
    { aid: 2n, lastView: null },
    { aid: 3n, lastView: null },
    { aid: 4n, lastView: null },
  ]);
  assert.deepEqual(calls, ["configured-accounts", "insert:1", "failed:2,3,4"]);
});

test("MinuteHandler advances unchanged tuples and marks a sampler failure", async () => {
  const calls: string[] = [];
  const unchangedHandler = new MinuteHandler({
    database: {
      ...database(calls),
      async getLatestCompleteVideoMinuteTuple(aid) {
        return complete(aid);
      },
    },
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [sample(1n)];
    },
  });
  await unchangedHandler.processBatch([{ aid: 1n, lastView: null }]);
  assert.deepEqual(calls, ["configured-accounts", "unchanged:1"]);

  const failedHandler = new MinuteHandler({
    database: database(calls),
    loadAccounts: () => [],
    async sampleVideoStats() {
      throw new Error("unavailable");
    },
  });
  await failedHandler.processBatch([{ aid: 2n, lastView: null }]);
  assert.ok(calls.includes("failed:2"));
});

test("MinuteHandler samples a zero-capacity configured account without enabling reconciliation mutations", async () => {
  const calls: string[] = [];
  let getRequests = 0;
  let postRequests = 0;
  const previousConfiguredAccounts = config.bilibili.watchLaterAccounts;
  config.bilibili.watchLaterAccounts = [
    {
      accountId: "7",
      capacity: 0,
      targetCount: 1,
      remoteCapacity: undefined,
    },
  ];
  const toViewClient = axios.create({
    adapter: async (request) => {
      if (request.method === "get") {
        getRequests += 1;
        return {
          data: {
            code: 0,
            data: {
              count: 1,
              list: [
                {
                  aid: 1,
                  stat: {
                    aid: 1,
                    coin: 1,
                    favorite: 1,
                    danmaku: 1,
                    view: 1,
                    reply: 1,
                    share: 1,
                    like: 1,
                  },
                },
              ],
            },
          },
          status: 200,
          statusText: "OK",
          headers: {},
          config: request,
        };
      }
      postRequests += 1;
      return {
        data: { code: 0 },
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    },
  });
  const account: AccountContext = {
    uid: "7",
    cookieJar: new CookieJar(),
    cookieFilePath: null,
    stateManager: {} as StateManager,
    dynamicClient: {} as AxiosInstance,
    webInterfaceClient: {} as AxiosInstance,
    playerClient: {} as AxiosInstance,
    relationClient: {} as AxiosInstance,
    toViewClient,
  };
  try {
    const db = {
      ...database(calls),
      async getConfiguredWatchLaterAccounts(accountIds: bigint[]) {
        calls.push("configured-accounts");
        assert.deepEqual(accountIds, [7n]);
        return [configuredAccount];
      },
    };
    const handler = new MinuteHandler({
      database: db,
      loadAccounts: () => [account],
    });

    await handler.processBatch([{ aid: 1n, lastView: null }]);
    await runAutomaticWatchLaterManagement(db, [account]);

    assert.equal(getRequests, 1);
    assert.equal(postRequests, 0);
    assert.deepEqual(calls, [
      "configured-accounts",
      "insert:1",
      "enabled-accounts",
    ]);
  } finally {
    config.bilibili.watchLaterAccounts = previousConfiguredAccounts;
  }
});
