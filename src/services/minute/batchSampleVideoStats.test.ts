import assert from "node:assert/strict";
import test from "node:test";
import {
  minuteFallbackResponseMissesTotal,
  watchLaterFallbackBatchesTotal,
  watchLaterFallbackVideosTotal,
} from "../../metrics/registry";
import { batchSampleVideoStats } from "./batchSampleVideoStats";
import type { ToViewRequestAccount } from "./toview";

function aids(count: number): bigint[] {
  return Array.from({ length: count }, (_, index) => BigInt(index + 1));
}

function completeFavoriteResponse(requested: bigint[]) {
  return {
    code: 0,
    data: requested.map((id) => ({
      id: Number(id),
      cnt_info: {
        coin: 1,
        collect: 1,
        danmaku: 1,
        play: 1,
        reply: 1,
        share: 1,
        thumb_up: 1,
      },
    })),
  };
}

function toViewAccount(
  uid: string,
  listedAids: number[],
  requests: number[],
): ToViewRequestAccount {
  return {
    uid,
    toViewClient: {
      async get() {
        requests.push(Number(uid));
        return {
          data: {
            code: 0,
            data: {
              count: listedAids.length,
              list: listedAids.map((aid) => ({
                aid,
                stat: {
                  aid,
                  coin: 1,
                  favorite: 1,
                  danmaku: 1,
                  view: 1,
                  reply: 1,
                  share: 1,
                  like: 1,
                },
              })),
            },
          },
        };
      },
    },
  };
}

test("batch sampler requests each configured To View account and falls back only for uncovered AIDs", async () => {
  const favoriteBatches: bigint[][] = [];
  const toViewRequests: number[] = [];
  const samples = await batchSampleVideoStats([1n, 2n, 3n], {
    toViewAccounts: [
      toViewAccount("10", [1], toViewRequests),
      toViewAccount("20", [2], toViewRequests),
    ],
    watchLaterToViewAccounts: [{ accountId: 10n }, { accountId: 20n }],
    dependencies: {
      async fetchStatsBatch(aids) {
        favoriteBatches.push(aids);
        return {
          code: 0,
          data: aids.map((id) => ({
            id: Number(id),
            cnt_info: {
              coin: 1,
              collect: 1,
              danmaku: 1,
              play: 1,
              reply: 1,
              share: 1,
              thumb_up: 1,
            },
          })),
        };
      },
    },
  });
  assert.deepEqual(favoriteBatches, [[3n]]);
  assert.deepEqual(toViewRequests, [10, 20]);
  assert.deepEqual(samples.map((sample) => sample.aid).sort(), [1n, 2n, 3n]);
});

test("batch sampler sends a duplicate complete To View candidate through the old path once", async () => {
  const favoriteBatches: bigint[][] = [];
  const samples = await batchSampleVideoStats([1n, 2n], {
    toViewAccounts: [
      toViewAccount("10", [1], []),
      toViewAccount("20", [1], []),
    ],
    watchLaterToViewAccounts: [{ accountId: 10n }, { accountId: 20n }],
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, [[1n, 2n]]);
  assert.deepEqual(samples.map((sample) => sample.aid).sort(), [1n, 2n]);
});

test("batch sampler conserves due AIDs across duplicate, malformed, and unrequested To View candidates", async () => {
  const favoriteBatches: bigint[][] = [];
  await batchSampleVideoStats([1n, 2n, 3n], {
    toViewAccounts: [
      toViewAccount("10", [1, 99], []),
      toViewAccount("20", [1], []),
      {
        uid: "30",
        toViewClient: {
          async get() {
            return { data: { code: 0, data: { count: 1, list: [] } } };
          },
        },
      },
    ],
    watchLaterToViewAccounts: [
      { accountId: 10n },
      { accountId: 20n },
      { accountId: 30n },
    ],
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, [[1n, 2n, 3n]]);
});

test("batch sampler de-duplicates due AIDs before the old-path dispatch", async () => {
  const favoriteBatches: bigint[][] = [];
  await batchSampleVideoStats([1n, 1n, 2n, 2n], {
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, [[1n, 2n]]);
});

test("batch sampler excludes healthy reassignment from startup-unavailable ownership fallback", async () => {
  const favoriteBatches: bigint[][] = [];
  const unavailableAccountIds = new Set<bigint>();
  watchLaterFallbackBatchesTotal.reset();
  watchLaterFallbackVideosTotal.reset();
  await batchSampleVideoStats([1n, 2n, 3n, 4n], {
    batchSize: 2,
    toViewAccounts: [
      {
        uid: "10",
        toViewClient: {
          async get() {
            return { data: { code: 0, data: { count: 1, list: [] } } };
          },
        },
      },
    ],
    watchLaterToViewAccounts: [{ accountId: 10n }],
    unavailableWatchLaterAccountIds: unavailableAccountIds,
    desiredWatchLaterAidsByAccountId: new Map([
      [10n, [3n]],
      [20n, [1n, 2n]],
    ]),
    onWatchLaterToViewAccountFailure(accountId) {
      unavailableAccountIds.add(accountId);
    },
    dependencies: {
      async fetchStatsBatch(aids) {
        favoriteBatches.push(aids);
        return { code: 0, data: [] };
      },
    },
  });
  assert.deepEqual(favoriteBatches, [
    [1n, 2n],
    [3n, 4n],
  ]);
  assert.deepEqual([...unavailableAccountIds], [10n]);
  assert.deepEqual((await watchLaterFallbackBatchesTotal.get()).values, [
    { labels: {}, value: 1 },
  ]);
  assert.deepEqual((await watchLaterFallbackVideosTotal.get()).values, [
    { labels: {}, value: 1 },
  ]);
});

test("batch sampler excludes unrelated gaps after a runtime To View account failure", async () => {
  watchLaterFallbackBatchesTotal.reset();
  watchLaterFallbackVideosTotal.reset();
  const unavailableAccountIds = new Set<bigint>();
  await batchSampleVideoStats([1n, 2n, 3n, 4n], {
    batchSize: 2,
    toViewAccounts: [
      {
        uid: "10",
        toViewClient: {
          async get() {
            throw new Error("unavailable");
          },
        },
      },
      toViewAccount("20", [3], []),
    ],
    watchLaterToViewAccounts: [{ accountId: 10n }, { accountId: 20n }],
    unavailableWatchLaterAccountIds: unavailableAccountIds,
    desiredWatchLaterAidsByAccountId: new Map([[10n, [1n, 2n]]]),
    onWatchLaterToViewAccountFailure(accountId) {
      unavailableAccountIds.add(accountId);
    },
    dependencies: {
      async fetchStatsBatch(aids) {
        return {
          code: 0,
          data: aids.map((id) => ({
            id: Number(id),
            cnt_info: {
              coin: 1,
              collect: 1,
              danmaku: 1,
              play: 1,
              reply: 1,
              share: 1,
              thumb_up: 1,
            },
          })),
        };
      },
    },
  });
  assert.deepEqual((await watchLaterFallbackBatchesTotal.get()).values, [
    { labels: {}, value: 1 },
  ]);
  assert.deepEqual((await watchLaterFallbackVideosTotal.get()).values, [
    { labels: {}, value: 2 },
  ]);
});

test("batch sampler does not count unrelated fallback gaps for unavailable accounts", async () => {
  watchLaterFallbackBatchesTotal.reset();
  watchLaterFallbackVideosTotal.reset();
  await batchSampleVideoStats([1n], {
    unavailableWatchLaterAccountIds: new Set([10n]),
    desiredWatchLaterAidsByAccountId: new Map([[10n, [9n]]]),
    dependencies: {
      async fetchStatsBatch() {
        return { code: 0, data: [] };
      },
    },
  });
  assert.deepEqual((await watchLaterFallbackBatchesTotal.get()).values, [
    { labels: {}, value: 0 },
  ]);
  assert.deepEqual((await watchLaterFallbackVideosTotal.get()).values, [
    { labels: {}, value: 0 },
  ]);
});

test("batch sampler sends a 55-AID due batch with no To View targets through the old 50-item path", async () => {
  const favoriteBatches: bigint[][] = [];
  const dueAids = aids(55);
  await batchSampleVideoStats(dueAids, {
    batchSize: 50,
    toViewAccounts: [toViewAccount("10", [], [])],
    watchLaterToViewAccounts: [{ accountId: 10n }],
    desiredWatchLaterAidsByAccountId: new Map([[10n, dueAids]]),
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, [dueAids.slice(0, 50), dueAids.slice(50)]);
});

test("batch sampler dispatches every To View-uncovered AID once across 50-item old-path chunks", async () => {
  const favoriteBatches: bigint[][] = [];
  const dueAids = aids(55);
  await batchSampleVideoStats(dueAids, {
    batchSize: 50,
    toViewAccounts: [toViewAccount("10", [1, 2], [])],
    watchLaterToViewAccounts: [{ accountId: 10n }],
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  const uncoveredAids = dueAids.slice(2);
  assert.deepEqual(favoriteBatches, [
    uncoveredAids.slice(0, 50),
    uncoveredAids.slice(50),
  ]);
  assert.deepEqual(favoriteBatches.flat(), uncoveredAids);
});

test("batch sampler skips the old path only when To View supplies every requested valid tuple", async () => {
  const favoriteBatches: bigint[][] = [];
  const dueAids = aids(55);
  await batchSampleVideoStats(dueAids, {
    batchSize: 50,
    toViewAccounts: [toViewAccount("10", dueAids.map(Number), [])],
    watchLaterToViewAccounts: [{ accountId: 10n }],
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, []);
});

test("batch sampler sends an invalid To View snapshot through the old path", async () => {
  const favoriteBatches: bigint[][] = [];
  const dueAids = aids(55);
  await batchSampleVideoStats(dueAids, {
    batchSize: 50,
    toViewAccounts: [
      {
        uid: "10",
        toViewClient: {
          async get() {
            return { data: { code: 0, data: { count: 1, list: [] } } };
          },
        },
      },
    ],
    watchLaterToViewAccounts: [{ accountId: 10n }],
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return completeFavoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(favoriteBatches, [dueAids.slice(0, 50), dueAids.slice(50)]);
});

test("batch sampler distinguishes missing and invalid old-path response tuples", async () => {
  const dueAids = aids(55);
  const favoriteBatches: bigint[][] = [];
  minuteFallbackResponseMissesTotal.reset();
  const samples = await batchSampleVideoStats(dueAids, {
    batchSize: 50,
    dependencies: {
      async fetchStatsBatch(batch) {
        favoriteBatches.push(batch);
        return {
          code: 0,
          data: [
            {
              id: 1,
              cnt_info: {
                coin: -1,
                collect: 1,
                danmaku: 1,
                play: 1,
                reply: 1,
                share: 1,
                thumb_up: 1,
              },
            },
          ],
        };
      },
    },
  });

  assert.deepEqual(favoriteBatches, [dueAids.slice(0, 50), dueAids.slice(50)]);
  assert.deepEqual(samples, []);
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    {
      labels: { reason: "missing_response_item" },
      value: 54,
    },
    {
      labels: { reason: "invalid_response_item" },
      value: 1,
    },
  ]);
});

test("batch sampler classifies API failures separately from code-zero invalid payloads", async () => {
  minuteFallbackResponseMissesTotal.reset();
  await batchSampleVideoStats([1n, 2n], {
    dependencies: {
      async fetchStatsBatch() {
        return { code: -400, data: [] };
      },
    },
  });
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    { labels: { reason: "api_failure" }, value: 2 },
  ]);

  minuteFallbackResponseMissesTotal.reset();
  await batchSampleVideoStats([1n, 2n], {
    dependencies: {
      async fetchStatsBatch() {
        return { code: 0, data: {} };
      },
    },
  });
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    { labels: { reason: "invalid_response" }, value: 2 },
  ]);
});
