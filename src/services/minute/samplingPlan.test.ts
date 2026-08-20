import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionMinuteSamplingCoverage,
  planFavoriteFallbackBatches,
} from "./samplingPlan";

function completeSample(aid: bigint) {
  return {
    aid,
    time: new Date(),
    coin: 1,
    favorite: 1,
    danmaku: 1,
    view: 1,
    reply: 1,
    share: 1,
    like: 1,
  };
}

test("favorite fallback batches only requested AIDs absent from To View", () => {
  const batches = planFavoriteFallbackBatches(
    [1n, 2n, 3n, 4n],
    [
      {
        aid: 1n,
        time: new Date(),
        coin: 1,
        favorite: 1,
        danmaku: 1,
        view: 1,
        reply: 1,
        share: 1,
        like: 1,
      },
    ],
    3,
  );
  assert.deepEqual(batches, [[2n, 3n, 4n]]);
});

test("duplicate complete To View tuples conservatively retain the AID for fallback", () => {
  const coverage = partitionMinuteSamplingCoverage(
    [1n, 2n],
    [completeSample(1n), completeSample(1n)],
  );

  assert.deepEqual(coverage.toViewSamples, []);
  assert.deepEqual(coverage.favoriteFallbackAids, [1n, 2n]);
});

test("To View coverage compares bigint AID identities without number coercion", () => {
  const largeAid = 9_007_199_254_740_993n;
  const coverage = partitionMinuteSamplingCoverage(
    [1n, largeAid],
    [completeSample(1n), completeSample(largeAid), completeSample(largeAid)],
  );

  assert.deepEqual(
    coverage.toViewSamples.map((sample) => sample.aid),
    [1n],
  );
  assert.deepEqual(coverage.favoriteFallbackAids, [largeAid]);
});

test("To View coverage conserves requested AIDs across duplicates, malformed tuples, and extras", () => {
  const coverage = partitionMinuteSamplingCoverage(
    [1n, 2n, 3n],
    [
      completeSample(1n),
      completeSample(1n),
      { ...completeSample(2n), view: null },
      completeSample(99n),
    ],
  );

  const coveredOrFallback = [
    ...coverage.toViewSamples.map((sample) => sample.aid),
    ...coverage.favoriteFallbackAids,
  ].sort();
  assert.deepEqual(coveredOrFallback, [1n, 2n, 3n]);
  assert.deepEqual(coverage.toViewSamples, []);
});

test("favorite fallback retains requested AIDs with invalid To View tuples", () => {
  const batches = planFavoriteFallbackBatches(
    [1n],
    [
      {
        aid: 1n,
        time: new Date(),
        coin: 1,
        favorite: 1,
        danmaku: 1,
        view: 1,
        reply: 1,
        share: 1,
      },
    ],
    50,
  );

  assert.deepEqual(batches, [[1n]]);
});
