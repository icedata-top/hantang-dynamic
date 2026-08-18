import assert from "node:assert/strict";
import test from "node:test";
import type { CompleteVideoMinuteTuple } from "../../types/models/minute";
import { shouldPersistMinuteSample } from "./persistencePolicy";

const previous: CompleteVideoMinuteTuple = {
  aid: 1n,
  time: new Date("2026-08-18T00:00:00.000Z"),
  coin: 1,
  favorite: 2,
  danmaku: 3,
  view: 100,
  reply: 4,
  share: 5,
  like: 6,
};

function sample(
  overrides: Partial<CompleteVideoMinuteTuple> = {},
): CompleteVideoMinuteTuple {
  return {
    ...previous,
    time: new Date("2026-08-18T00:01:00.000Z"),
    ...overrides,
  };
}

test("minute persistence stores the initial complete tuple", () => {
  assert.equal(shouldPersistMinuteSample(null, sample()), true);
});

test("minute persistence uses hundred bucket and strictly positive view delta boundaries", () => {
  assert.equal(
    shouldPersistMinuteSample(previous, sample({ view: 150 })),
    false,
  );
  assert.equal(
    shouldPersistMinuteSample(previous, sample({ view: 151 })),
    true,
  );
  assert.equal(
    shouldPersistMinuteSample(previous, sample({ view: 200 })),
    true,
  );
});

test("minute persistence stores other counter changes after fifteen elapsed minutes", () => {
  assert.equal(shouldPersistMinuteSample(previous, sample({ like: 7 })), false);
  assert.equal(
    shouldPersistMinuteSample(
      previous,
      sample({ like: 7, time: new Date("2026-08-18T00:15:00.000Z") }),
    ),
    true,
  );
});
