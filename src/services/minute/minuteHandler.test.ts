import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import type { AccountContext } from "../../core/account";
import type { StateManager } from "../../core/state";
import type {
  WatchLaterAccount,
  WatchLaterAccountLease,
} from "../../database/watchLater";
import {
  watchLaterAccountExclusionsTotal,
  watchLaterUnavailableAccounts,
} from "../../metrics/registry";
import type {
  CompleteVideoMinuteTuple,
  VideoMinuteSample,
} from "../../types/models/minute";
import { type MinuteDatabase, MinuteHandler } from "./minuteHandler";
import { runAutomaticWatchLaterManagement } from "./watchLaterReconciliation";

const configuredAccount: WatchLaterAccount = {
  accountId: 7n,
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
    async getWatchLaterAccounts() {
      calls.push("watch-later-accounts");
      return [configuredAccount];
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
      callback: (lease: WatchLaterAccountLease) => Promise<T>,
    ) {
      return callback({
        async renew() {
          return true;
        },
      });
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
  assert.deepEqual(calls, ["watch-later-accounts", "insert:1", "failed:2,3,4"]);
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
  assert.deepEqual(calls, ["watch-later-accounts", "unchanged:1"]);

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

test("MinuteHandler keeps a failed To View account unavailable across later batches", async () => {
  watchLaterAccountExclusionsTotal.reset();
  watchLaterUnavailableAccounts.set(0);
  const calls: string[] = [];
  const sampledAccountIds: bigint[][] = [];
  const fallbackBatches: bigint[][] = [];
  let toViewGetRequests = 0;
  let failedAccountUnavailable = false;
  const account = (uid: string): AccountContext => ({
    uid,
    cookieJar: new CookieJar(),
    cookieFilePath: null,
    enableWatchLater: true,
    stateManager: {} as StateManager,
    dynamicClient: {} as AxiosInstance,
    webInterfaceClient: {} as AxiosInstance,
    playerClient: {} as AxiosInstance,
    relationClient: {} as AxiosInstance,
    toViewClient: axios.create({
      adapter: async (request) => {
        if (uid === "7") throw new Error("To View GET failed");
        return {
          data: { code: 0, data: { count: 0, list: [] } },
          status: 200,
          statusText: "OK",
          headers: {},
          config: request,
        };
      },
    }),
  });
  const accounts = [account("7"), account("8")];
  const handler = new MinuteHandler({
    database: {
      ...database(calls),
      async getWatchLaterAccounts() {
        calls.push("watch-later-accounts");
        return [configuredAccount, { ...configuredAccount, accountId: 8n }];
      },
    },
    loadAccounts: () => accounts,
    async sampleVideoStats(aids, options) {
      const selectedIds = options?.watchLaterToViewAccounts?.map(
        (configured) => configured.accountId,
      );
      sampledAccountIds.push(selectedIds ?? []);
      if (selectedIds?.includes(7n)) {
        try {
          toViewGetRequests += 1;
          await accounts[0]?.toViewClient.get("/web");
        } catch {
          options?.onWatchLaterToViewAccountFailure?.(7n);
          failedAccountUnavailable = true;
        }
      }
      if (failedAccountUnavailable) {
        fallbackBatches.push(aids);
      }
      return aids.map(sample);
    },
  });

  await handler.processBatch([{ aid: 1n, lastView: null }]);
  await handler.processBatch([{ aid: 2n, lastView: null }]);

  assert.equal(toViewGetRequests, 1);
  assert.deepEqual(sampledAccountIds, [[7n, 8n], [8n]]);
  assert.deepEqual(fallbackBatches, [[1n], [2n]]);
  assert.deepEqual(calls, [
    "watch-later-accounts",
    "insert:1",
    "watch-later-accounts",
    "insert:2",
  ]);
  assert.deepEqual((await watchLaterAccountExclusionsTotal.get()).values, [
    { labels: { phase: "runtime_sampling" }, value: 1 },
  ]);
  assert.deepEqual((await watchLaterUnavailableAccounts.get()).values, [
    { labels: {}, value: 1 },
  ]);
});

test("MinuteHandler samples a zero-capacity enabled account without mutations", async () => {
  const calls: string[] = [];
  let getRequests = 0;
  let postRequests = 0;
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
    enableWatchLater: true,
    stateManager: {} as StateManager,
    dynamicClient: {} as AxiosInstance,
    webInterfaceClient: {} as AxiosInstance,
    playerClient: {} as AxiosInstance,
    relationClient: {} as AxiosInstance,
    toViewClient,
  };
  const db = {
    ...database(calls),
    async getWatchLaterAccounts(accountIds: bigint[]) {
      calls.push("watch-later-accounts");
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

  assert.equal(getRequests, 2);
  assert.equal(postRequests, 0);
  assert.deepEqual(calls, [
    "watch-later-accounts",
    "insert:1",
    "watch-later-accounts",
  ]);
});

test("MinuteHandler begins sampling while Watch Later convergence remains active", async () => {
  const calls: string[] = [];
  let resolveConvergence: (() => void) | undefined;
  const activeAccount = new Promise<void>((resolve) => {
    resolveConvergence = resolve;
  });
  const convergence = Promise.allSettled([
    Promise.reject(new Error("account branch failed")),
    activeAccount,
  ]);
  const handler = new MinuteHandler({
    database: {
      ...database(calls),
      async selectDueMinuteVideos() {
        calls.push("select-due");
        return [];
      },
    },
    loadAccounts: () => [],
    async startWatchLaterManagement() {
      calls.push("watch-later-started");
      return { convergence: convergence.then(() => []) };
    },
  });

  handler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["watch-later-started", "select-due"]);
  const stopping = handler.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  resolveConvergence?.();
  await stopping;
});
