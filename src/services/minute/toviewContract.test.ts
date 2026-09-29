import assert from "node:assert/strict";
import test from "node:test";
import { validateToViewResponse } from "./toviewContract";

const sampledAt = new Date("2026-08-18T00:00:00.000Z");

function item(aid = 1) {
  return {
    aid,
    pid_v2: 11,
    stat: {
      aid,
      coin: 1,
      favorite: 2,
      danmaku: 3,
      view: 4,
      reply: 5,
      share: 6,
      like: 7,
    },
  };
}

test("To View validator accepts only complete matching int32 tuples", () => {
  const result = validateToViewResponse(
    { code: 0, data: { count: 1, list: [item()] } },
    sampledAt,
  );
  assert.equal(result.invalidItemCount, 0);
  assert.equal(result.invalidPidV2Count, 0);
  assert.deepEqual(result.pidV2Metadata, [{ aid: 1n, pidV2: 11 }]);
  assert.deepEqual(result.samples[0], {
    ...item().stat,
    aid: 1n,
    time: sampledAt,
  });
});

test("To View validator rejects malformed counters, mismatched aids, and duplicates", () => {
  const malformed = item(2);
  malformed.stat.view = -1;
  const zeroAid = item(0);
  const oversized = item(5);
  oversized.stat.like = 2_147_483_648;
  const mismatched = item(3);
  mismatched.stat.aid = 4;
  const result = validateToViewResponse(
    {
      code: 0,
      data: {
        count: 6,
        list: [item(1), malformed, zeroAid, oversized, mismatched, item(1)],
      },
    },
    sampledAt,
  );
  assert.equal(result.samples.length, 1);
  assert.equal(result.invalidItemCount, 5);
});

test("To View validator keeps valid items when pid_v2 is absent, null, or malformed", () => {
  const absent = item(1) as Record<string, unknown>;
  delete absent.pid_v2;
  const nullPid = { ...item(2), pid_v2: null };
  const malformed = { ...item(3), pid_v2: "music" };
  const result = validateToViewResponse(
    { code: 0, data: { count: 3, list: [absent, nullPid, malformed] } },
    sampledAt,
  );
  assert.equal(result.samples.length, 3);
  assert.equal(result.invalidItemCount, 0);
  assert.equal(result.invalidPidV2Count, 1);
  assert.deepEqual(result.pidV2Metadata, []);
});
