import assert from "node:assert/strict";
import test from "node:test";
import type { AccountContext } from "../../core/account";
import { minuteSamplesTotal } from "../../metrics/registry";
import type { batchSampleVideoStats } from "./batchSampleVideoStats";
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
    async insertVideoMinuteSamplesWithGateCrossings() {
      return { inserted: 0, gateCrossings: [] };
    },
    async markVideoDeleted() {
      return 0n;
    },
    async getProcessedVideoAids() {
      return new Set();
    },
    async markVideosProcessedWithCollectionState() {
      return 0;
    },
    async refreshProcessedVideosFromRecommendations() {
      return 0;
    },
    async upsertPidV2Names() {
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

test("startup sampling -702 waits for the next scheduled cycle before retry", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  const rateLimitedAtCycleStart: boolean[] = [];
  let cycles = 0;
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async sampleVideoStats(_aids, options) {
      options?.onWatchLaterToViewAccountRateLimit?.(7n);
      return [];
    },
    async runWatchLaterManagement(_database, _accounts, _capacity, options) {
      rateLimitedAtCycleStart.push(
        options?.isAccountRateLimited?.(7n) ?? false,
      );
      cycles += 1;
      if (cycles === 2) {
        Reflect.set(handler, "isRunning", false);
        controller.abort();
      }
      return [];
    },
  });
  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [7n] },
  ]);
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

  assert.deepEqual(rateLimitedAtCycleStart, [true, false]);
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
    async insertVideoMinuteSamplesWithGateCrossings(samples) {
      insertedAids.push(...samples.map((sample) => sample.aid));
      return { inserted: samples.length, gateCrossings: [] };
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

test("new persisted gate crossings queue one recommendation source per video", async () => {
  const collected: bigint[][] = [];
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async insertVideoMinuteSamplesWithGateCrossings(samples) {
        return {
          inserted: samples.length,
          gateCrossings: [
            { aid: 1n, gateValue: 1_000n },
            { aid: 1n, gateValue: 2_000n },
            { aid: 2n, gateValue: 10_000n },
          ],
        };
      },
    },
    loadAccounts: () => [],
    recommendationRefreshService: {
      async collectForAids(sources) {
        collected.push(sources.map((source) => source.aid));
        return {
          errors: 0,
          imported: 0,
          metadataUpdated: 0,
          snapshots: new Map(),
        };
      },
    },
    async sampleVideoStats() {
      return [
        { aid: 1n, time: new Date("2026-08-18T00:01:00.000Z"), view: 1_100 },
        { aid: 2n, time: new Date("2026-08-18T00:01:00.000Z"), view: 10_100 },
      ];
    },
  });

  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
    { aid: 2n, lastView: null, watchLaterManagedAccountIds: [] },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(collected, [[1n, 2n]]);
});

test("recommendation refresh failure does not fail a persisted minute sample", async () => {
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async insertVideoMinuteSamplesWithGateCrossings(samples) {
        return {
          inserted: samples.length,
          gateCrossings: [{ aid: 1n, gateValue: 1_000n }],
        };
      },
    },
    loadAccounts: () => [],
    recommendationRefreshService: {
      async collectForAids() {
        throw new Error("recommendation request failed");
      },
    },
    async sampleVideoStats() {
      return [{ aid: 1n, time: new Date(), view: 1_001 }];
    },
  });

  minuteSamplesTotal.reset();
  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [{ labels: { outcome: "persisted" }, value: 1 }],
  );
  minuteSamplesTotal.reset();
});

test("minute handler stop waits for queued recommendation refresh", async () => {
  const refresh = deferred();
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    recommendationRefreshService: {
      async collectForAids() {
        await refresh.promise;
        return {
          errors: 0,
          imported: 0,
          metadataUpdated: 0,
          snapshots: new Map(),
        };
      },
    },
  });
  const enqueue = Reflect.get(handler, "enqueueRecommendationRefresh") as (
    sources: Array<{ aid: bigint }>,
  ) => void;
  enqueue.call(handler, [{ aid: 1n }]);
  handler.start();

  let stopped = false;
  const stopping = handler.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  refresh.resolve();
  await stopping;
  assert.equal(stopped, true);
});

test("unavailable gate lookup leaves a persisted minute sample successful", async () => {
  let collected = 0;
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async insertVideoMinuteSamplesWithGateCrossings(samples) {
        return {
          inserted: samples.length,
          gateCrossings: [],
          gateCrossingsError: new Error("gate lookup failed"),
        };
      },
    },
    loadAccounts: () => [],
    recommendationRefreshService: {
      async collectForAids() {
        collected += 1;
        return {
          errors: 0,
          imported: 0,
          metadataUpdated: 0,
          snapshots: new Map(),
        };
      },
    },
    async sampleVideoStats() {
      return [{ aid: 1n, time: new Date(), view: 1_001 }];
    },
  });

  minuteSamplesTotal.reset();
  await handler.processBatch([
    { aid: 1n, lastView: null, watchLaterManagedAccountIds: [] },
  ]);

  assert.equal(collected, 0);
  assert.deepEqual(
    (await minuteSamplesTotal.get()).values.map(({ labels, value }) => ({
      labels,
      value,
    })),
    [{ labels: { outcome: "persisted" }, value: 1 }],
  );
  minuteSamplesTotal.reset();
});

test("recommendation backlog applies bounded producer backpressure and drains", async () => {
  const first = deferred();
  const batches: bigint[][] = [];
  let calls = 0;
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    recommendationRefreshService: {
      async collectForAids(sources) {
        calls += 1;
        batches.push(sources.map((source) => source.aid));
        if (calls === 1) await first.promise;
        return {
          errors: 0,
          imported: 0,
          metadataUpdated: 0,
          snapshots: new Map(),
        };
      },
    },
  });
  Reflect.set(handler, "isRunning", true);
  const enqueue = Reflect.get(handler, "enqueueRecommendationRefresh") as (
    sources: Array<{ aid: bigint }>,
  ) => Promise<void>;
  let queued = false;
  const pending = enqueue
    .call(
      handler,
      Array.from({ length: 301 }, (_, index) => ({ aid: BigInt(index + 1) })),
    )
    .then(() => {
      queued = true;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queued, false);
  first.resolve();
  await pending;
  await handler.stop();

  assert.ok(batches.every((batch) => batch.length <= 100));
  assert.deepEqual(
    batches.flat(),
    Array.from({ length: 301 }, (_, index) => BigInt(index + 1)),
  );
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
    async insertVideoMinuteSamplesWithGateCrossings(samples) {
      assert.deepEqual(
        samples.map((sample) => sample.aid),
        [1n],
      );
      return { inserted: samples.length, gateCrossings: [] };
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

type SampleOptions = Parameters<typeof batchSampleVideoStats>[1];

function watchLaterAccount(uid: string): AccountContext {
  return { uid, enableWatchLater: true } as unknown as AccountContext;
}

/** Sampler stand-in whose favorite endpoint answered but omitted `aids`. */
function favoriteOmits(
  missing: { aid: bigint; absentFromToViewAccountId: bigint | null }[],
) {
  return async (_aids: bigint[], options?: SampleOptions) => {
    options?.onFavoriteFallbackMissing?.(missing);
    return [];
  };
}

interface MissingVideoHarness {
  handler: MinuteHandler;
  deleted: { identity: unknown; notes: unknown }[];
  advanced: bigint[];
  detailLookups: bigint[];
  additions: { uid: string; aid: bigint; action: string }[];
}

function missingVideoHarness(options: {
  missing: { aid: bigint; absentFromToViewAccountId: bigint | null }[];
  detail: (aid: bigint) => Promise<unknown | null>;
  accounts?: AccountContext[];
  addCode?: number;
}): MissingVideoHarness {
  const deleted: MissingVideoHarness["deleted"] = [];
  const advanced: bigint[] = [];
  const detailLookups: bigint[] = [];
  const additions: MissingVideoHarness["additions"] = [];
  const handler = new MinuteHandler({
    database: {
      ...database(() => {}),
      async markVideoDeleted(identity, notes) {
        deleted.push({ identity, notes });
        return 0n;
      },
      async advanceFailedMinuteVideos(aids) {
        advanced.push(...aids);
        return aids.length;
      },
    },
    loadAccounts: () => options.accounts ?? [],
    sampleVideoStats: favoriteOmits(options.missing),
    async fetchVideoDetail(aid) {
      detailLookups.push(aid);
      return options.detail(aid);
    },
    async mutateWatchLater(account, aid, action) {
      additions.push({ uid: account.uid, aid, action });
      return options.addCode ?? 0;
    },
  });
  return { handler, deleted, advanced, detailLookups, additions };
}

function dueVideo(aid: bigint, watchLaterManagedAccountIds: bigint[] = []) {
  return { aid, lastView: null, watchLaterManagedAccountIds };
}

test("a video Bilibili reports deleted is marked deleted instead of resampled", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: null }],
    detail: async () => null,
  });

  await harness.handler.processBatch([dueVideo(5n)]);
  await harness.handler.stop();

  assert.deepEqual(harness.deleted, [
    { identity: { type: "aid", aid: 5n }, notes: undefined },
  ]);
  assert.deepEqual(harness.additions, []);
  assert.deepEqual(harness.advanced, [5n]);
});

test("an unavailable video is marked deleted with its API code", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: 7n }],
    accounts: [watchLaterAccount("7")],
    async detail(aid) {
      throw new Error(`VIDEO_UNAVAILABLE:${aid}:62012:private: only owner`);
    },
  });

  await harness.handler.processBatch([dueVideo(5n, [7n])]);
  await harness.handler.stop();

  assert.deepEqual(harness.deleted, [
    {
      identity: { type: "aid", aid: 5n },
      notes: { api_code: 62012, api_message: "private: only owner" },
    },
  ]);
  assert.deepEqual(harness.additions, []);
});

test("an existing video missing from its Watch Later list is added back", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: 7n }],
    accounts: [watchLaterAccount("3"), watchLaterAccount("7")],
    detail: async () => ({ data: {} }),
  });

  await harness.handler.processBatch([dueVideo(5n, [7n])]);
  await harness.handler.stop();

  assert.deepEqual(harness.additions, [{ uid: "7", aid: 5n, action: "add" }]);
  assert.deepEqual(harness.deleted, []);
});

test("an existing video that was in no Watch Later list is left alone", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: null }],
    accounts: [watchLaterAccount("7")],
    detail: async () => ({ data: {} }),
  });

  await harness.handler.processBatch([dueVideo(5n)]);
  await harness.handler.stop();

  assert.deepEqual(harness.detailLookups, [5n]);
  assert.deepEqual(harness.additions, []);
  assert.deepEqual(harness.deleted, []);
});

test("a failed detail lookup neither deletes nor re-adds the video", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: 7n }],
    accounts: [watchLaterAccount("7")],
    async detail() {
      throw new Error("API Error: Fetch video full detail failed");
    },
  });

  await harness.handler.processBatch([dueVideo(5n, [7n])]);
  await harness.handler.stop();

  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.additions, []);
  assert.deepEqual(harness.advanced, [5n]);
});

test("a video is not re-checked within ten minutes", async () => {
  const harness = missingVideoHarness({
    missing: [{ aid: 5n, absentFromToViewAccountId: null }],
    detail: async () => ({ data: {} }),
  });

  await harness.handler.processBatch([dueVideo(5n)]);
  await harness.handler.stop();
  await harness.handler.processBatch([dueVideo(5n)]);
  await harness.handler.stop();

  assert.deepEqual(harness.detailLookups, [5n]);
});

test("a rate-limited add stops further additions for that account", async () => {
  const harness = missingVideoHarness({
    missing: [
      { aid: 5n, absentFromToViewAccountId: 7n },
      { aid: 6n, absentFromToViewAccountId: 7n },
    ],
    accounts: [watchLaterAccount("7")],
    detail: async () => ({ data: {} }),
    addCode: -702,
  });

  await harness.handler.processBatch([dueVideo(5n, [7n]), dueVideo(6n, [7n])]);
  await harness.handler.stop();

  assert.deepEqual(harness.additions, [{ uid: "7", aid: 5n, action: "add" }]);
  assert.deepEqual(harness.deleted, []);
});

test("videos that were sampled successfully are never checked", async () => {
  const detailLookups: bigint[] = [];
  const sampledAt = new Date("2026-08-18T00:01:00.000Z");
  const handler = new MinuteHandler({
    database: database(() => {}),
    loadAccounts: () => [],
    async sampleVideoStats() {
      return [{ aid: 1n, time: sampledAt, favorite: 1, view: 100 }];
    },
    async fetchVideoDetail(aid) {
      detailLookups.push(aid);
      return null;
    },
  });

  await handler.processBatch([dueVideo(1n)]);
  await handler.stop();

  assert.deepEqual(detailLookups, []);
});
