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

test("batch sampler conservatively falls back after an invalid To View snapshot", async () => {
  const favoriteBatches: bigint[][] = [];
  const unavailableAccountIds = new Set<bigint>();
  watchLaterFallbackBatchesTotal.reset();
  watchLaterFallbackVideosTotal.reset();
  await batchSampleVideoStats([1n], {
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
  assert.deepEqual(favoriteBatches, [[1n]]);
  assert.deepEqual([...unavailableAccountIds], [10n]);
  assert.deepEqual((await watchLaterFallbackBatchesTotal.get()).values, [
    { labels: {}, value: 1 },
  ]);
  assert.deepEqual((await watchLaterFallbackVideosTotal.get()).values, [
    { labels: {}, value: 1 },
  ]);
});
