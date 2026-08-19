import assert from "node:assert/strict";
import test from "node:test";
import {
  watchLaterFallbackBatchesTotal,
  watchLaterFallbackVideosTotal,
} from "../../metrics/registry";
import { batchSampleVideoStats } from "./batchSampleVideoStats";
import type { ToViewRequestAccount } from "./toview";

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
