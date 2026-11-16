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

function tagItem(aid: number, fields: Record<string, unknown>) {
  const { pid_v2: _pidV2, ...base } = item(aid);
  return {
    ...base,
    tid: 30,
    tname: "VOCALOID·UTAU",
    tnamev2: "VOCALOID",
    pid_name_v2: "音乐",
    ...fields,
  };
}

test("To View validator carries tidv2 next to pid_v2 independently", () => {
  const result = validateToViewResponse(
    {
      code: 0,
      data: {
        count: 3,
        list: [
          tagItem(1, { tidv2: 2022, pid_v2: 1003 }),
          tagItem(2, { tidv2: 2055 }),
          tagItem(3, { tidv2: 2022, pid_v2: 0 }),
        ],
      },
    },
    sampledAt,
  );
  assert.equal(result.invalidItemCount, 0);
  assert.deepEqual(result.tidV2Metadata, [
    { aid: 1n, tidV2: 2022 },
    { aid: 2n, tidV2: 2055 },
    { aid: 3n, tidV2: 2022 },
  ]);
  assert.deepEqual(result.pidV2Metadata, [{ aid: 1n, pidV2: 1003 }]);
});

test("To View validator drops zero, absent, and malformed tidv2 without failing the item", () => {
  const absent = tagItem(1, {});
  const zero = tagItem(2, {
    tidv2: 0,
    pid_v2: 0,
    tnamev2: "",
    pid_name_v2: "",
  });
  const malformed = ["2022", null, 1.5, -1, 2_147_483_648].map((tidv2, index) =>
    tagItem(10 + index, { tidv2 }),
  );
  const list = [absent, zero, ...malformed];
  const result = validateToViewResponse(
    { code: 0, data: { count: list.length, list } },
    sampledAt,
  );
  assert.equal(result.invalidItemCount, 0);
  assert.equal(result.samples.length, list.length);
  assert.deepEqual(result.tidV2Metadata, []);
});

test("To View validator reads only the tidv2 key", () => {
  const underscoreOnly = tagItem(1, { tid_v2: 2022 });
  const both = tagItem(2, { tid_v2: 2022, tidv2: 2055 });
  const result = validateToViewResponse(
    { code: 0, data: { count: 2, list: [underscoreOnly, both] } },
    sampledAt,
  );
  assert.deepEqual(result.tidV2Metadata, [{ aid: 2n, tidV2: 2055 }]);
});
