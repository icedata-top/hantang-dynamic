import assert from "node:assert/strict";
import test from "node:test";
import type { PersistableVideoMinuteSample } from "../../types/models/minute";
import { shouldPersistMinuteSample } from "./persistencePolicy";

const previous: PersistableVideoMinuteSample = {
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
  overrides: Partial<PersistableVideoMinuteSample> = {},
): PersistableVideoMinuteSample {
  return {
    ...previous,
    time: new Date("2026-08-18T00:01:00.000Z"),
    ...overrides,
  };
}

test("minute persistence stores the initial tuple", () => {
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

test("minute persistence applies view thresholds to partial tuples", () => {
  const partialPrevious: PersistableVideoMinuteSample = {
    aid: 1n,
    time: previous.time,
    favorite: 2,
    view: 100,
  };
  const partial = (overrides: Partial<PersistableVideoMinuteSample> = {}) => ({
    ...partialPrevious,
    time: new Date("2026-08-18T00:01:00.000Z"),
    ...overrides,
  });

  assert.equal(shouldPersistMinuteSample(null, partial()), true);
  assert.equal(shouldPersistMinuteSample(partialPrevious, partial()), false);
  assert.equal(
    shouldPersistMinuteSample(partialPrevious, partial({ view: 151 })),
    true,
  );
  assert.equal(
    shouldPersistMinuteSample(partialPrevious, partial({ view: 200 })),
    true,
  );
});

test("minute persistence compares only counters supplied by the current partial tuple", () => {
  const partialPrevious: PersistableVideoMinuteSample = {
    ...previous,
    time: new Date("2026-08-18T00:00:00.000Z"),
  };
  const afterInterval = new Date("2026-08-18T00:15:00.000Z");

  assert.equal(
    shouldPersistMinuteSample(partialPrevious, {
      aid: 1n,
      time: afterInterval,
      view: 100,
    }),
    false,
  );
  assert.equal(
    shouldPersistMinuteSample(partialPrevious, {
      aid: 1n,
      time: afterInterval,
      favorite: 3,
      view: 100,
    }),
    true,
  );
});

test("complete tuples retain supplied-counter persistence behavior", () => {
  assert.equal(
    shouldPersistMinuteSample(previous, {
      ...previous,
      time: new Date("2026-08-18T00:15:00.000Z"),
      coin: 2,
    }),
    true,
  );
});
