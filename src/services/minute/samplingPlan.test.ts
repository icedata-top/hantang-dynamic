import assert from "node:assert/strict";
import test from "node:test";
import { planFavoriteFallbackBatches } from "./samplingPlan";

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
