import assert from "node:assert/strict";
import test from "node:test";
import {
  batchSampleVideoStats,
  selectWatchLaterRouting,
} from "./batchSampleVideoStats";

function toViewResponse(aid: number) {
  return {
    code: 0,
    data: {
      count: 1,
      list: [
        {
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
        },
      ],
    },
  };
}

function favoriteResponse(aids: bigint[]) {
  return {
    code: 0,
    data: aids.map((aid) => ({
      id: Number(aid),
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

test("routing selects the smallest healthy positive UID only", () => {
  const routing = selectWatchLaterRouting(
    [1n, 2n],
    new Map([
      ["1", [-1n, 9n, 7n]],
      ["2", [8n]],
    ]),
    new Set([7n, 9n]),
  );
  assert.deepEqual([...routing], [[7n, [1n]]]);
});

test("healthy selected UID covers its AID and never queries a larger UID", async () => {
  let smallCalls = 0;
  let largeCalls = 0;
  let fallbackCalls = 0;
  const samples = await batchSampleVideoStats([1n], {
    toViewAccounts: [
      {
        uid: "7",
        toViewClient: {
          async get() {
            smallCalls += 1;
            return { data: toViewResponse(1) };
          },
        },
      },
      {
        uid: "9",
        toViewClient: {
          async get() {
            largeCalls += 1;
            return { data: toViewResponse(1) };
          },
        },
      },
    ],
    observedWatchLaterAccountIdsByAid: new Map([["1", [-1n, 9n, 7n]]]),
    healthyWatchLaterAccountIds: new Set([7n, 9n]),
    dependencies: {
      async fetchStatsBatch(aids) {
        fallbackCalls += 1;
        return favoriteResponse(aids);
      },
    },
  });
  assert.equal(smallCalls, 1);
  assert.equal(largeCalls, 0);
  assert.equal(fallbackCalls, 0);
  assert.equal(samples.length, 1);
});

test("empty, sentinel, disabled, failed, missing, and duplicate coverage fall back exactly once", async () => {
  const fallbackBatches: bigint[][] = [];
  const samples = await batchSampleVideoStats([1n, 2n, 3n, 4n, 5n], {
    batchSize: 50,
    toViewAccounts: [
      {
        uid: "7",
        toViewClient: {
          async get() {
            const item = toViewResponse(4).data.list[0];
            return {
              data: { code: 0, data: { count: 2, list: [item, item] } },
            };
          },
        },
      },
    ],
    observedWatchLaterAccountIdsByAid: new Map([
      ["1", []],
      ["2", [-1n]],
      ["3", [8n]],
      ["4", [7n]],
      ["5", [7n]],
    ]),
    healthyWatchLaterAccountIds: new Set([7n]),
    dependencies: {
      async fetchStatsBatch(aids) {
        fallbackBatches.push(aids);
        return favoriteResponse(aids);
      },
    },
  });
  assert.deepEqual(fallbackBatches, [[1n, 2n, 3n, 4n, 5n]]);
  assert.equal(samples.length, 5);
});

test("fallback conserves unique large bigint AIDs in fifty-item chunks", async () => {
  const aids = Array.from(
    { length: 51 },
    (_, index) => 9_007_199_254_740_000n + BigInt(index),
  );
  const batches: bigint[][] = [];
  await batchSampleVideoStats(aids, {
    batchSize: 50,
    dependencies: {
      async fetchStatsBatch(batch) {
        batches.push(batch);
        return { code: 0, data: [] };
      },
    },
  });
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [50, 1],
  );
  assert.equal(batches[0]?.[0], aids[0]);
});

test("a stale UID is not queried when current health is empty and falls back in fifty-item batches", async () => {
  const aids = Array.from({ length: 50 }, (_, index) => BigInt(index + 1));
  const fallbackBatches: bigint[][] = [];
  let staleUidCalls = 0;
  await batchSampleVideoStats(aids, {
    batchSize: 50,
    toViewAccounts: [
      {
        uid: "7",
        toViewClient: {
          async get() {
            staleUidCalls += 1;
            return { data: toViewResponse(1) };
          },
        },
      },
    ],
    observedWatchLaterAccountIdsByAid: new Map(
      aids.map((aid) => [aid.toString(), [7n]]),
    ),
    healthyWatchLaterAccountIds: new Set(),
    dependencies: {
      async fetchStatsBatch(batch) {
        fallbackBatches.push(batch);
        return favoriteResponse(batch);
      },
    },
  });
  assert.equal(staleUidCalls, 0);
  assert.deepEqual(fallbackBatches, [aids]);
});
