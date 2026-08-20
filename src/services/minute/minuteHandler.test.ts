import assert from "node:assert/strict";
import test from "node:test";
import type { MinuteDatabase } from "./minuteHandler";
import { MinuteHandler } from "./minuteHandler";

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
    async advanceUnchangedMinuteVideos() {
      return 0;
    },
    async getWatchLaterAccounts() {
      return [];
    },
    async getDesiredWatchLaterSet() {
      return { aids: [], mandatoryCount: 0, overflow: false };
    },
    async syncWatchLaterSnapshot() {
      return 0;
    },
    async withWatchLaterAccountLease() {
      throw new Error("not used");
    },
    async getLatestCompleteVideoMinuteTuple() {
      return null;
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
  assert.deepEqual(delays, [15 * 60_000]);
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
