import assert from "node:assert/strict";
import test from "node:test";
import { minuteSamplesTotal } from "../../metrics/registry";
import type { MinuteDatabase } from "./minuteHandler";
import {
  MinuteHandler,
  WATCH_LATER_RATE_LIMIT_COOLDOWN_MS,
} from "./minuteHandler";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function database(onSelect: () => void): MinuteDatabase {
  return {
    async advanceFailedMinuteVideos() {
      return 0;
    },
    async advanceSuppressedMinuteSamples() {
      return 0;
    },
    async getDesiredWatchLaterSet() {
      return [];
    },
    async syncWatchLaterSnapshot() {
      return 0;
    },
    async getLatestVideoMinuteSamples() {
      return new Map();
    },
    async getNextMinuteDueAt() {
      return null;
    },
    async insertVideoMinuteSamples() {
      return 0;
    },
    async selectDueMinuteVideos() {
      onSelect();
      return [];
    },
  };
}

test("minute sampling starts independently while the first watch-later cycle starts immediately", async () => {
  const cycle = deferred();
  let sampled = 0;
  let cycles = 0;
  const handler = new MinuteHandler({
    database: database(() => {
      sampled += 1;
    }),
    loadAccounts: () => [],
    async runWatchLaterManagement() {
      cycles += 1;
      await cycle.promise;
      return [];
    },
  });

  handler.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sampled, 1);
  assert.equal(cycles, 1);

  let stopped = false;
  const stopping = handler.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(cycles, 1);
  cycle.resolve();
  await stopping;
  assert.equal(stopped, true);
});

test("watch-later cycles run immediately after an overrun", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  let now = 0;
  let cycles = 0;
  const controller = new AbortController();
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async runWatchLaterManagement() {
      cycles += 1;
      if (cycles === 1) {
        now = 15 * 60_000 + 1;
        return [];
      }
      Reflect.set(handler, "isRunning", false);
      controller.abort();
      return [];
    },
  });
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    queueMicrotask(callback);
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout;
  Reflect.set(handler, "isRunning", true);
  try {
    const run = Reflect.get(handler, "runWatchLaterController") as (
      signal: AbortSignal,
    ) => Promise<void>;
    await run.call(handler, controller.signal);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(cycles, 2);
  assert.deepEqual(delays, [0]);
});

test("watch-later cycles schedule fifteen minutes from the prior start", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  let cycles = 0;
  const controller = new AbortController();
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async runWatchLaterManagement() {
      cycles += 1;
      if (cycles === 2) {
        Reflect.set(handler, "isRunning", false);
        controller.abort();
      }
      return [];
    },
  });
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    queueMicrotask(callback);
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout;
  Reflect.set(handler, "isRunning", true);
  try {
    const run = Reflect.get(handler, "runWatchLaterController") as (
      signal: AbortSignal,
    ) => Promise<void>;
    await run.call(handler, controller.signal);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(cycles, 2);
  assert.equal(delays.length, 1);
  const delay = delays[0];
  const fifteenMinutes = 15 * 60_000;
  assert.ok(delay >= fifteenMinutes * 0.95);
  assert.ok(delay <= fifteenMinutes * 1.05);
});

test("failed controller cycle clears prior routing health before minute sampling", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  const routedAccountIds: bigint[][] = [];
  let cycles = 0;
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async sampleVideoStats(_aids, options) {
      routedAccountIds.push([
        ...(options?.healthyWatchLaterAccountIds ?? new Set()),
      ]);
      return [];
    },
    async runWatchLaterManagement(_database, _accounts, _capacity, options) {
      cycles += 1;
      if (cycles === 1) {
        options?.onHealthyAccounts?.(new Set([7n]));
        return [];
      }
      await handler.processBatch([
        {
          aid: 1n,
          lastView: null,
          watchLaterManagedAccountIds: [7n],
        },
      ]);
      Reflect.set(handler, "isRunning", false);
      controller.abort();
      throw new Error("snapshot sync failed");
    },
  });
  globalThis.setTimeout = ((callback: () => void) => {
    queueMicrotask(callback);
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout;
  Reflect.set(handler, "isRunning", true);
  try {
    const run = Reflect.get(handler, "runWatchLaterController") as (
      signal: AbortSignal,
    ) => Promise<void>;
    await run.call(handler, controller.signal);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(routedAccountIds, [[]]);
});

test("partial favorite samples persist initially and advance suppressed observations", async () => {
  const insertedAids: bigint[] = [];
  const suppressedSamples: { aid: bigint; time: Date; view: number }[] = [];
  const failedAids: bigint[] = [];
  const sampledAt = new Date("2026-08-18T00:01:00.000Z");
  const db: MinuteDatabase = {
    ...database(() => {}),
    async getLatestVideoMinuteSamples(aids) {
      assert.deepEqual(aids, [1n, 2n, 3n]);
      return new Map([
        [
          2n,
          {
            aid: 2n,
            time: new Date("2026-08-18T00:00:00.000Z"),
            favorite: 1,
            view: 100,
          },
        ],
        [
          3n,
          {
            aid: 3n,
            time: new Date("2026-08-18T00:00:00.000Z"),
            favorite: 1,
            view: 100,
          },
        ],
      ]);
    },
    async insertVideoMinuteSamples(samples) {
      insertedAids.push(...samples.map((sample) => sample.aid));
      return samples.length;
    },
    async advanceSuppressedMinuteSamples(samples) {
      suppressedSamples.push(...samples);
      return samples.length;
    },
    async advanceFailedMinuteVideos(aids) {
      failedAids.push(...aids);
      return aids.length;
    },
  };
  const handler = new MinuteHandler({
    database: db,
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [
        { aid: 1n, time: sampledAt, favorite: 1, view: 100 },
        { aid: 2n, time: sampledAt, favorite: 1, view: 101 },
        { aid: 3n, time: sampledAt, favorite: 1, view: 100 },
      ];
    },
  });

  minuteSamplesTotal.reset();
  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
    { aid: 2n, lastView: 100n, watchLaterManagedAccountIds: [] },
    { aid: 3n, lastView: 100n, watchLaterManagedAccountIds: [] },
  ]);

  assert.deepEqual(insertedAids, [1n]);
  assert.deepEqual(suppressedSamples, [
    { aid: 2n, time: sampledAt, favorite: 1, view: 101 },
    { aid: 3n, time: sampledAt, favorite: 1, view: 100 },
  ]);
  assert.deepEqual(failedAids, []);
  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [
      { labels: { outcome: "persisted" }, value: 1 },
      { labels: { outcome: "suppressed" }, value: 2 },
    ],
  );
  minuteSamplesTotal.reset();
});

test("counts persisted samples before a later suppressed-state write fails", async () => {
  const sampledAt = new Date("2026-08-18T00:01:00.000Z");
  const db: MinuteDatabase = {
    ...database(() => {}),
    async getLatestVideoMinuteSamples() {
      return new Map([
        [
          2n,
          {
            aid: 2n,
            time: new Date("2026-08-18T00:00:00.000Z"),
            favorite: 1,
            view: 100,
          },
        ],
      ]);
    },
    async insertVideoMinuteSamples(samples) {
      assert.deepEqual(
        samples.map((sample) => sample.aid),
        [1n],
      );
      return samples.length;
    },
    async advanceSuppressedMinuteSamples() {
      throw new Error("suppressed state write failed");
    },
  };
  const handler = new MinuteHandler({
    database: db,
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [
        { aid: 1n, time: sampledAt, favorite: 1, view: 100 },
        { aid: 2n, time: sampledAt, favorite: 1, view: 100 },
      ];
    },
  });

  minuteSamplesTotal.reset();
  await assert.rejects(
    handler.processBatch([
      { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
      { aid: 2n, lastView: 100n, watchLaterManagedAccountIds: [] },
      { aid: 3n, lastView: null, watchLaterManagedAccountIds: [] },
    ]),
    /suppressed state write failed/,
  );
  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [
      { labels: { outcome: "persisted" }, value: 1 },
      { labels: { outcome: "failed" }, value: 2 },
    ],
  );
  minuteSamplesTotal.reset();
});

test("counts all samples failed when latest-sample lookup fails", async () => {
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async getLatestVideoMinuteSamples() {
        throw new Error("latest sample lookup failed");
      },
    },
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [
        { aid: 1n, time: new Date(), view: 1 },
        { aid: 2n, time: new Date(), view: 2 },
      ];
    },
  });

  minuteSamplesTotal.reset();
  await assert.rejects(
    handler.processBatch([
      { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
      { aid: 2n, lastView: null, watchLaterManagedAccountIds: [] },
    ]),
    /latest sample lookup failed/,
  );
  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [{ labels: { outcome: "failed" }, value: 2 }],
  );
  minuteSamplesTotal.reset();
});

test("counts failed samples when retry-state advancement also fails", async () => {
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async advanceFailedMinuteVideos() {
        throw new Error("retry state write failed");
      },
    },
    loadAccounts: () => [],
    async sampleVideoStats() {
      throw new Error("sampling failed");
    },
  });

  minuteSamplesTotal.reset();
  await assert.rejects(
    handler.processBatch([
      { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
    ]),
    /retry state write failed/,
  );
  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [{ labels: { outcome: "failed" }, value: 1 }],
  );
  minuteSamplesTotal.reset();
});

test("failed sampling advances retry state against the attempt start", async () => {
  let attemptStartedAt: Date | undefined;
  const beforeAttempt = new Date();
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async advanceFailedMinuteVideos(_aids, startedAt) {
        attemptStartedAt = startedAt;
        return 1;
      },
    },
    loadAccounts: () => [],
    async sampleVideoStats() {
      throw new Error("sampling failed");
    },
  });

  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
  ]);

  assert.ok(attemptStartedAt);
  assert.ok(attemptStartedAt >= beforeAttempt);
  assert.ok(attemptStartedAt <= new Date());
});

test("a failed To View account is removed from subsequent batch routing", async () => {
  const routedAccountIds: bigint[][] = [];
  let calls = 0;
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async sampleVideoStats(_aids, options) {
      routedAccountIds.push([
        ...(options?.healthyWatchLaterAccountIds ?? new Set()),
      ]);
      calls += 1;
      if (calls === 1) {
        options?.onWatchLaterToViewAccountFailure?.(7n);
      }
      return [];
    },
  });
  const publish = Reflect.get(handler, "setHealthyWatchLaterAccounts") as (
    accountIds: ReadonlySet<bigint>,
  ) => void;
  publish.call(handler, new Set([7n]));
  const due = [{ aid: 1n, lastView: null, watchLaterManagedAccountIds: [7n] }];

  await handler.processBatch(due);
  await handler.processBatch(due);

  assert.deepEqual(routedAccountIds, [[7n], []]);
});

test("repeated -702 retries on the next cycle, then cools the account for 30 minutes", async () => {
  const originalNow = Date.now;
  const routedAccountIds: bigint[][] = [];
  let now = 0;
  let calls = 0;
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async sampleVideoStats(_aids, options) {
      routedAccountIds.push([
        ...(options?.healthyWatchLaterAccountIds ?? new Set()),
      ]);
      if (calls === 0 || calls === 2) {
        options?.onWatchLaterToViewAccountRateLimit?.(7n);
      }
      calls += 1;
      return [];
    },
  });
  const publish = Reflect.get(handler, "setHealthyWatchLaterAccounts") as (
    accountIds: ReadonlySet<bigint>,
  ) => void;
  const due = [{ aid: 1n, lastView: null, watchLaterManagedAccountIds: [7n] }];
  Date.now = () => now;
  try {
    publish.call(handler, new Set([7n]));
    await handler.processBatch(due);
    publish.call(handler, new Set([7n]));
    await handler.processBatch(due);
    Reflect.set(handler, "watchLaterCycle", 1);
    publish.call(handler, new Set([7n]));
    await handler.processBatch(due);
    Reflect.set(handler, "watchLaterCycle", 2);
    publish.call(handler, new Set([7n]));
    await handler.processBatch(due);
    now = WATCH_LATER_RATE_LIMIT_COOLDOWN_MS;
    Reflect.set(handler, "watchLaterCycle", 3);
    publish.call(handler, new Set([7n]));
    await handler.processBatch(due);
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(routedAccountIds, [[7n], [], [7n], [], [7n]]);
});
