import assert from "node:assert/strict";
import test from "node:test";
import { partitionDesiredWatchLaterAids } from "./watchLaterReconciliation";

test("assigns each desired AID to exactly one account in deterministic order", () => {
  assert.deepEqual(partitionDesiredWatchLaterAids([1n, 2n, 3n, 4n, 5n], 2), [
    [1n, 3n, 5n],
    [2n, 4n],
  ]);
});
