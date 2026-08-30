import assert from "node:assert/strict";
import test from "node:test";
import { minuteFallbackResponseMissesTotal } from "../../metrics/registry";
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

function favoriteResponseWithStringTuples(aids: bigint[]) {
  return {
    code: 0,
    data: aids.map((aid) => ({
      id: aid.toString(),
      cnt_info: {
        coin: "0",
        collect: "1",
        danmaku: "2",
        play: "3",
        reply: "4",
        share: "5",
        thumb_up: "6",
      },
    })),
  };
}

function observedFavoriteResponse(aids: bigint[]) {
  return {
    code: 0,
    data: aids.map((aid) => ({
      id: Number(aid),
      cnt_info: {
        collect: 1,
        play: 2,
        danmaku: 3,
        reply: 4,
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

test("favorite proxy and direct fallback use one bounded attempt", async () => {
  const requests: Array<{
    source: string;
    noRetry: true;
    timeout: number;
  }> = [];
  const samples = await batchSampleVideoStats([1n], {
    dependencies: {
      favoriteClient: {
        async get(_url, request) {
          requests.push({
            source: "proxy",
            noRetry: request.noRetry,
            timeout: request.timeout,
          });
          throw new Error("proxy unavailable");
        },
      },
      favoriteDirectClient: {
        async get(_url, request) {
          requests.push({
            source: "direct",
            noRetry: request.noRetry,
            timeout: request.timeout,
          });
          return { data: favoriteResponse([1n]) };
        },
      },
    },
  });

  assert.deepEqual(requests, [
    { source: "proxy", noRetry: true, timeout: 120_000 },
    { source: "direct", noRetry: true, timeout: 120_000 },
  ]);
  assert.equal(samples.length, 1);
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

test("To View -702 cools the account and sends its AIDs through configured fallback batches", async () => {
  const cooled: bigint[] = [];
  const fallbackBatches: bigint[][] = [];
  const aids = Array.from({ length: 51 }, (_, index) => BigInt(index + 1));

  await batchSampleVideoStats(aids, {
    batchSize: 50,
    toViewAccounts: [
      {
        uid: "7",
        toViewClient: {
          async get() {
            return { data: { code: -702 } };
          },
        },
      },
    ],
    observedWatchLaterAccountIdsByAid: new Map(
      aids.map((aid) => [aid.toString(), [7n]]),
    ),
    healthyWatchLaterAccountIds: new Set([7n]),
    onWatchLaterToViewAccountRateLimit(accountId) {
      cooled.push(accountId);
    },
    dependencies: {
      async fetchStatsBatch(batch) {
        fallbackBatches.push(batch);
        return favoriteResponse(batch);
      },
    },
  });

  assert.deepEqual(cooled, [7n]);
  assert.deepEqual(
    fallbackBatches.map((batch) => batch.length),
    [50, 1],
  );
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

test("favorite fallback accepts a full live-shape batch with partial counters", async () => {
  const aids = Array.from({ length: 50 }, (_, index) => BigInt(index + 1));
  minuteFallbackResponseMissesTotal.reset();

  const samples = await batchSampleVideoStats(aids, {
    dependencies: {
      async fetchStatsBatch(batch) {
        return observedFavoriteResponse(batch);
      },
    },
  });

  assert.equal(samples.length, 50);
  assert.deepEqual(samples[0], {
    aid: 1n,
    time: samples[0]?.time,
    favorite: 1,
    view: 2,
    danmaku: 3,
    reply: 4,
  });
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, []);
});

test("favorite fallback normalizes string tuples and rejects malformed present counters", async () => {
  const requestedAids = [
    9_007_199_254_740_993n,
    ...Array.from({ length: 49 }, (_, index) => BigInt(index + 1)),
  ];
  minuteFallbackResponseMissesTotal.reset();
  const samples = await batchSampleVideoStats(requestedAids, {
    dependencies: {
      async fetchStatsBatch(aids) {
        const response: { code: number; data: unknown[] } =
          favoriteResponseWithStringTuples(aids);
        response.data[1] = {
          id: "1",
          cnt_info: {
            play: "3",
          },
        };
        response.data[2] = {
          id: "2",
          cnt_info: {
            coin: "0",
            collect: "1",
            danmaku: "2",
            play: "3",
            reply: "4",
            share: "5",
            thumb_up: "-1",
          },
        };
        response.data.push({
          id: "51",
          cnt_info: {
            coin: "0",
            collect: "1",
            danmaku: "2",
            play: "3",
            reply: "4",
            share: "5",
            thumb_up: "6",
          },
        });
        return response;
      },
    },
  });

  assert.deepEqual(
    samples.map((sample) => sample.aid),
    requestedAids.filter((aid) => aid !== 2n),
  );
  assert.deepEqual(samples[0], {
    aid: 9_007_199_254_740_993n,
    time: samples[0]?.time,
    coin: 0,
    favorite: 1,
    danmaku: 2,
    view: 3,
    reply: 4,
    share: 5,
    like: 6,
  });
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    { labels: { reason: "invalid_response_item" }, value: 1 },
  ]);
});

test("favorite fallback rejects missing or malformed play", async () => {
  minuteFallbackResponseMissesTotal.reset();
  const samples = await batchSampleVideoStats([1n, 2n, 3n], {
    dependencies: {
      async fetchStatsBatch() {
        return {
          code: 0,
          data: [
            { id: 1, cnt_info: { collect: 1 } },
            { id: 2, cnt_info: { play: "-1" } },
            { id: 3, cnt_info: { play: "4" } },
          ],
        };
      },
    },
  });

  assert.deepEqual(
    samples.map((sample) => sample.aid),
    [3n],
  );
  assert.equal(samples[0]?.view, 4);
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    { labels: { reason: "invalid_response_item" }, value: 2 },
  ]);
});

test("favorite fallback records final request failures before rethrowing", async () => {
  minuteFallbackResponseMissesTotal.reset();
  await assert.rejects(
    batchSampleVideoStats([1n, 2n], {
      dependencies: {
        async fetchStatsBatch() {
          throw new Error("favorite request failed");
        },
      },
    }),
    /favorite request failed/,
  );
  assert.deepEqual((await minuteFallbackResponseMissesTotal.get()).values, [
    { labels: { reason: "api_failure" }, value: 2 },
  ]);
  minuteFallbackResponseMissesTotal.reset();
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
