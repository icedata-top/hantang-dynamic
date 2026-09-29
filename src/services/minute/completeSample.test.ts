import assert from "node:assert/strict";
import test from "node:test";
import { isCompleteVideoMinuteSample } from "./completeSample";

test("complete minute samples require a positive AID and seven int32 counters", () => {
  const valid = {
    aid: 1n,
    time: new Date(),
    coin: 0,
    favorite: 0,
    danmaku: 0,
    view: 0,
    reply: 0,
    share: 0,
    like: 0,
  };

  assert.equal(isCompleteVideoMinuteSample(valid), true);
  assert.equal(isCompleteVideoMinuteSample({ ...valid, aid: 0n }), false);
  assert.equal(
    isCompleteVideoMinuteSample({ ...valid, like: 2_147_483_648 }),
    false,
  );
});
