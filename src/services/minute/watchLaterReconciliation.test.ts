import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import {
  createAccountToViewClient,
  type RequestConfig,
} from "../../api/client";
import { config } from "../../config";
import { StateManager } from "../../core/state";
import type {
  WatchLaterAccount,
  WatchLaterAccountLease,
} from "../../database/watchLater";
import {
  watchLaterAccountSlotItems,
  watchLaterCapacity,
  watchLaterEnabledAccounts,
  watchLaterMutationsTotal,
  watchLaterReconciliationsTotal,
} from "../../metrics/registry";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import {
  mutateWatchLater,
  type WatchLaterAccountContext,
  WatchLaterMutationPrePostAbortError,
} from "./watchLaterApi";
import {
  partitionDesiredWatchLaterAids,
  reconcileWatchLaterAccount,
  runAutomaticWatchLaterManagement,
  runWatchLaterEmpiricalAddTest,
  selectWatchLaterEmpiricalAccount,
  startAutomaticWatchLaterManagement,
  WATCH_LATER_CAPACITY,
  type WatchLaterDatabase,
  type WatchLaterEmpiricalDatabase,
} from "./watchLaterReconciliation";

function item(aid: number) {
  return {
    aid,
    stat: {
      aid,
      coin: 1,
      favorite: 1,
      danmaku: 1,
      view: 1,
      reply: 1,
      share: 1,
      like: 1,
    },
  };
}

function account(
  responses: Array<{
    code: number;
    data?: { count: number; list: ReturnType<typeof item>[] };
  }>,
  mutationCodes: number[] = [],
  uid = "7",
  onGet?: () => void,
): WatchLaterAccountContext {
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync("bili_jct=test", "https://www.bilibili.com/");
  return {
    uid,
    cookieJar,
    enableWatchLater: true,
    toViewClient: {
      async get() {
        onGet?.();
        const response = responses.shift();
        if (!response) throw new Error("missing snapshot");
        return { data: response };
      },
      async post() {
        return { data: { code: mutationCodes.shift() ?? 0 } };
      },
    },
  };
}

function snapshot(aids: number[]) {
  return { code: 0, data: { count: aids.length, list: aids.map(item) } };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function database(
  overrides: Partial<WatchLaterDatabase> = {},
): WatchLaterDatabase {
  return {
    async getDesiredWatchLaterSet() {
      return { aids: [], overflow: false };
    },
    async getWatchLaterOwnedAids() {
      return [];
    },
    async getRecoverableWatchLaterOperations() {
      return [];
    },
    async createWatchLaterOperation() {},
    async recordWatchLaterOperationAttempt() {
      return true;
    },
    async resolveWatchLaterOperation() {
      return true;
    },
    async removeWatchLaterOwnershipAfterCompleteSnapshot() {
      return 0;
    },
    async recordWatchLaterCompleteSnapshot() {},
    async withWatchLaterAccountLease<T>(
      _accountId: bigint,
      callback: (lease: WatchLaterAccountLease) => Promise<T>,
    ) {
      return callback({
        async renew() {
          return true;
        },
      });
    },
    ...overrides,
  };
}

async function waitForSharedApiQueue(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (sharedApiRateLimiter.getQueueLength() > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("mutation did not enter the shared API limiter queue");
}

const configured: WatchLaterAccount = {
  accountId: 7n,
  capacityBlockedAt: null,
  lastCompleteSnapshotAt: null,
};

test("automatic management reaches loaded enabled accounts", async () => {
  let lookedUp = false;
  const result = await runAutomaticWatchLaterManagement(
    {
      ...database(),
      async getWatchLaterAccounts(accountIds) {
        lookedUp = true;
        assert.deepEqual(accountIds, [7n]);
        return [configured];
      },
    },
    [account([{ code: 0, data: { count: 0, list: [] } }])],
  );
  assert.equal(result.length, 1);
  assert.equal(lookedUp, true);
});

test("disabled authentication accounts are excluded from watch-later selection", async () => {
  let lookedUp = false;
  const disabledAccount = account([{ code: 0, data: { count: 0, list: [] } }]);
  disabledAccount.enableWatchLater = false;
  const result = await runAutomaticWatchLaterManagement(
    {
      ...database(),
      async getWatchLaterAccounts(accountIds) {
        lookedUp = true;
        assert.deepEqual(accountIds, []);
        return [];
      },
    },
    [disabledAccount],
  );
  assert.equal(lookedUp, true);
  assert.deepEqual(result, []);
});

test("enabled accounts reconcile independently with the shared injected capacity", async () => {
  const operations: Array<{ accountId: bigint; aid: bigint }> = [];
  let desiredTarget = 0;
  const results = await runAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet(target) {
          desiredTarget = target;
          return { aids: [1n, 2n, 3n, 4n], overflow: false };
        },
        async createWatchLaterOperation(input) {
          operations.push({ accountId: input.accountId, aid: input.aid });
        },
      }),
      async getWatchLaterAccounts(accountIds) {
        assert.deepEqual(accountIds, [7n, 8n]);
        return [configured, { ...configured, accountId: 8n }];
      },
    },
    [
      account([{ code: 0, data: { count: 0, list: [] } }]),
      account([{ code: 0, data: { count: 0, list: [] } }], [], "8"),
    ],
    2,
  );

  assert.equal(results.length, 2);
  assert.equal(desiredTarget, 4);
  assert.deepEqual(operations, [
    { accountId: 7n, aid: 1n },
    { accountId: 8n, aid: 2n },
    { accountId: 7n, aid: 3n },
    { accountId: 8n, aid: 4n },
  ]);
});

test("background convergence completes multiple chunks from one startup snapshot", async () => {
  const operations: Array<{ action: string; aid: bigint }> = [];
  const delays: number[] = [];
  let snapshots = 0;
  const run = await startAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet() {
          return { aids: [10n, 11n, 12n, 13n], overflow: false };
        },
        async createWatchLaterOperation(input) {
          operations.push({ action: input.action, aid: input.aid });
        },
      }),
      async getWatchLaterAccounts() {
        return [configured];
      },
    },
    [account([snapshot([1, 2, 3, 4])], [], "7", () => snapshots++)],
    4,
    {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      mutationChunkSize: 2,
    },
  );

  const [result] = await run.convergence;
  assert.equal(snapshots, 1);
  assert.equal(result.deleted, 4);
  assert.equal(result.added, 4);
  assert.deepEqual(operations, [
    { action: "delete", aid: 1n },
    { action: "delete", aid: 2n },
    { action: "delete", aid: 3n },
    { action: "delete", aid: 4n },
    { action: "add", aid: 10n },
    { action: "add", aid: 11n },
    { action: "add", aid: 12n },
    { action: "add", aid: 13n },
  ]);
  assert.deepEqual(delays, Array(7).fill(1_000));
  assert.deepEqual((await watchLaterAccountSlotItems.get()).values, [
    { labels: { account_slot: "0", kind: "assigned" }, value: 4 },
    { labels: { account_slot: "0", kind: "observed" }, value: 4 },
    { labels: { account_slot: "0", kind: "remaining_delete" }, value: 0 },
    { labels: { account_slot: "0", kind: "remaining_add" }, value: 0 },
  ]);
});

test("background convergence serializes mutation pacing globally across account chunks", async () => {
  const posts: string[] = [];
  const delays: number[] = [];
  const first = account([snapshot([])], [], "7");
  const second = account([snapshot([])], [], "8");
  first.toViewClient.post = async () => {
    posts.push("7");
    return { data: { code: 0 } };
  };
  second.toViewClient.post = async () => {
    posts.push("8");
    return { data: { code: 0 } };
  };

  const run = await startAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n, 2n, 3n, 4n], overflow: false };
        },
      }),
      async getWatchLaterAccounts() {
        return [configured, { ...configured, accountId: 8n }];
      },
    },
    [first, second],
    2,
    {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      mutationChunkSize: 1,
    },
  );

  await run.convergence;
  assert.deepEqual(posts, ["7", "8", "7", "8"]);
  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
});

test("lease renewal retains a multi-chunk convergence lease beyond five minutes", async () => {
  let now = 0;
  let leaseExpiresAt = 300_000;
  let competingAcquisitionSucceeded = false;
  const operationAids: bigint[] = [];
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return {
          aids: Array.from({ length: 7 }, (_, index) => BigInt(index + 1)),
          overflow: false,
        };
      },
      async createWatchLaterOperation(input) {
        operationAids.push(input.aid);
      },
      async withWatchLaterAccountLease<T>(
        _accountId: bigint,
        callback: (lease: WatchLaterAccountLease) => Promise<T>,
      ) {
        return callback({
          async renew() {
            if (now >= leaseExpiresAt) return false;
            leaseExpiresAt = now + 300_000;
            return true;
          },
        });
      },
    }),
    account([snapshot([])]),
    configured,
    async () => {
      now += 60_001;
      if (now > 300_000 && now >= leaseExpiresAt) {
        competingAcquisitionSucceeded = true;
      }
    },
    7,
  );

  assert.equal(result.reason, "completed");
  assert.equal(now > 300_000, true);
  assert.equal(competingAcquisitionSucceeded, false);
  assert.equal(leaseExpiresAt > now, true);
  assert.equal(operationAids.length, 7);
});

test("lease renewal failure stops an account before its next mutation", async () => {
  let posts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n, 2n], overflow: false };
      },
      async withWatchLaterAccountLease<T>(
        _accountId: bigint,
        callback: (lease: WatchLaterAccountLease) => Promise<T>,
      ) {
        return callback({
          async renew() {
            return false;
          },
        });
      },
    }),
    guardedAccount,
    configured,
    async () => {},
    2,
  );

  assert.equal(result.reason, "lease_lost");
  assert.equal(posts, 0);
});

test("cancelling an account while its mutation is queued sends no POST", async () => {
  const releaseLimiter = await sharedApiRateLimiter.acquire();
  let continueRunning = true;
  let posts = 0;
  let attempts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  try {
    const reconciliation = reconcileWatchLaterAccount(
      database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n], overflow: false };
        },
        async recordWatchLaterOperationAttempt() {
          attempts += 1;
          return true;
        },
      }),
      guardedAccount,
      configured,
      async () => {},
      1,
      {
        snapshot: { aids: new Set(), completedAt: new Date() },
        shouldContinue: () => continueRunning,
      },
    );
    await waitForSharedApiQueue();
    continueRunning = false;
    releaseLimiter();

    assert.equal((await reconciliation).reason, "stopped");
    assert.equal(posts, 0);
    assert.equal(attempts, 0);
  } finally {
    if (sharedApiRateLimiter.getActiveCount() > 0) releaseLimiter();
  }
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("cancelling during CSRF request preparation sends no POST", async () => {
  const csrfLookupStarted = deferred<void>();
  const releaseCsrfLookup = deferred<void>();
  const originalCsrfToken = config.bilibili.csrfToken;
  const guardedAccount = account([snapshot([])]);
  const cookieJar = guardedAccount.cookieJar;
  assert.ok(cookieJar);
  const getCookies = cookieJar.getCookies.bind(cookieJar);
  cookieJar.getCookies = async (url: string) => {
    csrfLookupStarted.resolve();
    await releaseCsrfLookup.promise;
    return getCookies(url);
  };
  config.bilibili.csrfToken = undefined;

  let continueRunning = true;
  let posts = 0;
  let renewals = 0;
  let attempts = 0;
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  try {
    const reconciliation = reconcileWatchLaterAccount(
      database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n], overflow: false };
        },
        async recordWatchLaterOperationAttempt() {
          attempts += 1;
          return true;
        },
        async withWatchLaterAccountLease<T>(
          _accountId: bigint,
          callback: (lease: WatchLaterAccountLease) => Promise<T>,
        ) {
          return callback({
            async renew() {
              renewals += 1;
              return true;
            },
          });
        },
      }),
      guardedAccount,
      configured,
      async () => {},
      1,
      {
        snapshot: { aids: new Set(), completedAt: new Date() },
        shouldContinue: () => continueRunning,
      },
    );
    await csrfLookupStarted.promise;
    continueRunning = false;
    releaseCsrfLookup.resolve();

    assert.equal((await reconciliation).reason, "stopped");
    assert.equal(posts, 0);
    assert.equal(renewals, 0);
    assert.equal(attempts, 0);
  } finally {
    config.bilibili.csrfToken = originalCsrfToken;
  }
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("cancelling during lease renewal sends no POST", async () => {
  const renewalStarted = deferred<void>();
  const releaseRenewal = deferred<void>();
  let continueRunning = true;
  let posts = 0;
  let attempts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  const reconciliation = reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
      async recordWatchLaterOperationAttempt() {
        attempts += 1;
        return true;
      },
      async withWatchLaterAccountLease<T>(
        _accountId: bigint,
        callback: (lease: WatchLaterAccountLease) => Promise<T>,
      ) {
        return callback({
          async renew() {
            renewalStarted.resolve();
            await releaseRenewal.promise;
            return true;
          },
        });
      },
    }),
    guardedAccount,
    configured,
    async () => {},
    1,
    {
      snapshot: { aids: new Set(), completedAt: new Date() },
      shouldContinue: () => continueRunning,
    },
  );
  await renewalStarted.promise;
  continueRunning = false;
  releaseRenewal.resolve();

  assert.equal((await reconciliation).reason, "stopped");
  assert.equal(posts, 0);
  assert.equal(attempts, 0);
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("cancelling after durable attempt marking sends no POST and retains recovery intent", async () => {
  const attemptStarted = deferred<void>();
  const releaseAttempt = deferred<void>();
  let continueRunning = true;
  let posts = 0;
  let attempts = 0;
  let resolved = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  const reconciliation = reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
      async recordWatchLaterOperationAttempt() {
        attempts += 1;
        attemptStarted.resolve();
        await releaseAttempt.promise;
        return true;
      },
      async resolveWatchLaterOperation() {
        resolved += 1;
        return true;
      },
    }),
    guardedAccount,
    configured,
    async () => {},
    1,
    {
      snapshot: { aids: new Set(), completedAt: new Date() },
      shouldContinue: () => continueRunning,
    },
  );
  await attemptStarted.promise;
  continueRunning = false;
  releaseAttempt.resolve();

  assert.equal((await reconciliation).reason, "stopped");
  assert.equal(posts, 0);
  assert.equal(attempts, 1);
  assert.equal(resolved, 0);
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("an expired queued lease loses ownership before the mutation POST", async () => {
  const releaseLimiter = await sharedApiRateLimiter.acquire();
  let now = 0;
  let leaseExpiresAt = 300_000;
  let competingAcquisitionSucceeded = false;
  let posts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  try {
    const reconciliation = reconcileWatchLaterAccount(
      database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n], overflow: false };
        },
        async withWatchLaterAccountLease<T>(
          _accountId: bigint,
          callback: (lease: WatchLaterAccountLease) => Promise<T>,
        ) {
          return callback({
            async renew() {
              if (now >= leaseExpiresAt) return false;
              leaseExpiresAt = now + 300_000;
              return true;
            },
          });
        },
      }),
      guardedAccount,
      configured,
      async () => {},
      1,
      { snapshot: { aids: new Set(), completedAt: new Date() } },
    );
    await waitForSharedApiQueue();
    now = 300_000;
    competingAcquisitionSucceeded = now >= leaseExpiresAt;
    releaseLimiter();

    assert.equal((await reconciliation).reason, "lease_lost");
    assert.equal(competingAcquisitionSucceeded, true);
    assert.equal(posts, 0);
  } finally {
    if (sharedApiRateLimiter.getActiveCount() > 0) releaseLimiter();
  }
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("a valid guard after shared limiter acquisition sends exactly one POST", async () => {
  const releaseLimiter = await sharedApiRateLimiter.acquire();
  let posts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  try {
    const reconciliation = reconcileWatchLaterAccount(
      database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n], overflow: false };
        },
      }),
      guardedAccount,
      configured,
      async () => {},
      1,
      { snapshot: { aids: new Set(), completedAt: new Date() } },
    );
    await waitForSharedApiQueue();
    releaseLimiter();

    assert.equal((await reconciliation).reason, "completed");
    assert.equal(posts, 1);
  } finally {
    if (sharedApiRateLimiter.getActiveCount() > 0) releaseLimiter();
  }
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("a throwing pre-POST guard releases the limiter without dispatching", async () => {
  let posts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };

  await assert.rejects(
    () =>
      mutateWatchLater(guardedAccount, 1n, "add", {
        async beforePost() {
          throw new Error("lease store unavailable");
        },
      }),
    (error: unknown) =>
      error instanceof WatchLaterMutationPrePostAbortError &&
      error.reason === "lease_lost",
  );
  assert.equal(posts, 0);
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);

  await mutateWatchLater(guardedAccount, 1n, "add");
  assert.equal(posts, 1);
  assert.equal(sharedApiRateLimiter.getQueueLength(), 0);
  assert.equal(sharedApiRateLimiter.getActiveCount(), 0);
});

test("an unavailable durable attempt marker stops the account without posting", async () => {
  let posts = 0;
  const guardedAccount = account([snapshot([])]);
  guardedAccount.toViewClient.post = async () => {
    posts += 1;
    return { data: { code: 0 } };
  };
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
      async recordWatchLaterOperationAttempt() {
        return false;
      },
    }),
    guardedAccount,
    configured,
    async () => {},
    1,
  );

  assert.equal(result.reason, "attempt_unavailable");
  assert.equal(posts, 0);
});

test("background convergence settles every account after an isolated branch failure", async () => {
  let releaseSecondAccount: (() => void) | undefined;
  const secondAccountReady = new Promise<void>((resolve) => {
    releaseSecondAccount = resolve;
  });
  const run = await startAutomaticWatchLaterManagement(
    {
      ...database(),
      async getWatchLaterAccounts() {
        return [configured, { ...configured, accountId: 8n }];
      },
      async withWatchLaterAccountLease<T>(
        accountId: bigint,
        callback: (lease: WatchLaterAccountLease) => Promise<T>,
      ) {
        if (accountId === 7n) throw new Error("lease acquisition failed");
        await secondAccountReady;
        return callback({
          async renew() {
            return true;
          },
        });
      },
    },
    [account([snapshot([])]), account([snapshot([])], [], "8")],
  );
  let settled = false;
  void run.convergence.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseSecondAccount?.();
  assert.equal((await run.convergence).length, 1);
});

test("desired Watch Later aids have deterministic deduplicated assignments for two and three accounts", () => {
  const desired = [1n, 2n, 2n, 3n, 4n, 5n, 6n, 7n];

  assert.deepEqual(partitionDesiredWatchLaterAids(desired, 2, 3), [
    [1n, 3n, 5n],
    [2n, 4n, 6n],
  ]);
  assert.deepEqual(partitionDesiredWatchLaterAids(desired, 3, 3), [
    [1n, 4n, 7n],
    [2n, 5n],
    [3n, 6n],
  ]);
});

test("desired Watch Later assignments cap global and per-account cardinality", () => {
  const assignments = partitionDesiredWatchLaterAids(
    Array.from({ length: 3_005 }, (_, index) => BigInt(index + 1)),
    3,
  );
  const assigned = assignments.flat();

  assert.equal(assigned.length, 3_000);
  assert.equal(new Set(assigned).size, 3_000);
  assert.deepEqual(
    assignments.map((aids) => aids.length),
    [1_000, 1_000, 1_000],
  );
});

test("startup health excludes invalid accounts from capacity and assignment", async () => {
  watchLaterEnabledAccounts.reset();
  watchLaterCapacity.reset();
  watchLaterAccountSlotItems.reset();
  let desiredTarget = -1;
  const unavailableAccountIds: bigint[] = [];
  let assignments = new Map<bigint, readonly bigint[]>();
  const operations: Array<{ accountId: bigint; aid: bigint }> = [];
  const healthy = account([snapshot([])]);
  const invalid = account([{ code: -101 }], [], "8");
  const result = await runAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet(target) {
          desiredTarget = target;
          return { aids: [1n, 2n], overflow: false };
        },
        async getWatchLaterOwnedAids(accountId) {
          return accountId === 8n ? [1n, 3n] : [];
        },
        async createWatchLaterOperation(input) {
          operations.push({ accountId: input.accountId, aid: input.aid });
        },
      }),
      async getWatchLaterAccounts() {
        return [configured, { ...configured, accountId: 8n }];
      },
    },
    [healthy, invalid],
    2,
    {
      onUnavailableAccount(accountId) {
        unavailableAccountIds.push(accountId);
      },
      onDesiredAssignments(value) {
        assignments = new Map(value);
      },
    },
  );

  assert.equal(desiredTarget, 2);
  assert.equal(result.length, 1);
  assert.deepEqual(unavailableAccountIds, [8n]);
  assert.deepEqual(operations, [
    { accountId: 7n, aid: 1n },
    { accountId: 7n, aid: 2n },
  ]);
  assert.deepEqual(
    assignments,
    new Map([
      [7n, [1n, 2n]],
      [8n, [3n]],
    ]),
  );
  assert.deepEqual((await watchLaterEnabledAccounts.get()).values, [
    { labels: { state: "healthy" }, value: 1 },
    { labels: { state: "unavailable" }, value: 1 },
  ]);
  assert.deepEqual((await watchLaterCapacity.get()).values, [
    { labels: { pool: "total" }, value: 2 },
    { labels: { pool: "priority" }, value: 1 },
    { labels: { pool: "newest" }, value: 1 },
  ]);
  assert.deepEqual((await watchLaterAccountSlotItems.get()).values, [
    { labels: { account_slot: "0", kind: "assigned" }, value: 2 },
    { labels: { account_slot: "0", kind: "observed" }, value: 2 },
    { labels: { account_slot: "0", kind: "remaining_delete" }, value: 0 },
    { labels: { account_slot: "0", kind: "remaining_add" }, value: 0 },
  ]);
});

test("zero injected capacity samples the remote snapshot without posting mutations", async () => {
  let requestedTarget = -1;
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet(target) {
        requestedTarget = target;
        return { aids: [], overflow: false };
      },
    }),
    account([{ code: 0, data: { count: 0, list: [] } }]),
    configured,
    async () => {},
    0,
  );
  assert.equal(result.reason, "completed");
  assert.equal(requestedTarget, -1);
});

test("default reconciliation capacity enables the measured 1000-item target", async () => {
  let requestedTarget = -1;
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet(target) {
        requestedTarget = target;
        return { aids: [], overflow: false };
      },
    }),
    account([snapshot([])]),
    configured,
    async () => {},
  );
  assert.equal(WATCH_LATER_CAPACITY, 1_000);
  assert.equal(requestedTarget, 1_000);
});

test("an injected positive capacity is the reconciliation target", async () => {
  let requestedTarget = -1;
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet(target) {
        requestedTarget = target;
        return { aids: [], overflow: false };
      },
    }),
    account([{ code: 0, data: { count: 0, list: [] } }]),
    configured,
    async () => {},
    2,
  );
  assert.equal(result.reason, "completed");
  assert.equal(requestedTarget, 2);
});

test("each account reserves capacity already used by its watch-later snapshot", async () => {
  const attemptedAids: bigint[] = [];
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n, 2n], overflow: false };
      },
      async createWatchLaterOperation(input) {
        attemptedAids.push(input.aid);
      },
    }),
    account([{ code: 0, data: { count: 1, list: [item(1)] } }], [0]),
    configured,
    async () => {},
    2,
  );
  assert.equal(result.added, 1);
  assert.deepEqual(attemptedAids, [2n]);
});

test("dedicated accounts delete unmanaged remote entries before adding at capacity", async () => {
  const operations: Array<{ action: string; aid: bigint }> = [];
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [3n], overflow: false };
      },
      async createWatchLaterOperation(input) {
        operations.push({ action: input.action, aid: input.aid });
      },
    }),
    account([snapshot([1, 2])], [0, 0, 0]),
    configured,
    async () => {},
    2,
  );

  assert.deepEqual(operations, [
    { action: "delete", aid: 1n },
    { action: "delete", aid: 2n },
    { action: "add", aid: 3n },
  ]);
  assert.equal(result.deleted, 2);
  assert.equal(result.added, 1);
});

test("empirical account selection rejects zero or multiple enabled accounts", () => {
  const disabled = account([snapshot([])]);
  disabled.enableWatchLater = false;
  assert.throws(
    () => selectWatchLaterEmpiricalAccount([disabled]),
    /found none/,
  );
  assert.throws(
    () =>
      selectWatchLaterEmpiricalAccount([
        account([snapshot([])]),
        account([snapshot([])], [], "8"),
      ]),
    /found multiple/,
  );
});

test("empirical account selection returns the sole enabled loaded account", () => {
  const disabled = account([snapshot([])]);
  disabled.enableWatchLater = false;
  const enabled = account([snapshot([])], [], "8");
  assert.equal(selectWatchLaterEmpiricalAccount([disabled, enabled]), enabled);
});

test("empirical add test skips a failed add and marks its candidate", async () => {
  const marked: bigint[] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [2n, 3n];
      },
      async markWatchLaterEmpiricalFailedAid(aid) {
        marked.push(aid);
        return true;
      },
    } satisfies WatchLaterEmpiricalDatabase,
    account([snapshot([]), snapshot([2])], [0, -400]),
    async () => {},
  );
  assert.equal(result.reason, "eligible_exhausted");
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(marked, [3n]);
});

test("empirical add test skips unsupported interactive videos", async () => {
  let posts = 0;
  const marked: bigint[] = [];
  const skippedAccount = account([snapshot([]), snapshot([2, 3])]);
  skippedAccount.toViewClient.post = async () => {
    posts += 1;
    if (posts === 1) {
      throw {
        status: 200,
        data: { code: 90002, message: "interactive video is unsupported" },
      };
    }
    return { data: { code: 0 } };
  };
  let progress = "";
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n, 2n, 3n];
      },
      async markWatchLaterEmpiricalFailedAid(aid) {
        marked.push(aid);
        return true;
      },
    } satisfies WatchLaterEmpiricalDatabase,
    skippedAccount,
    async () => {},
    (text) => {
      progress += text;
    },
  );

  assert.deepEqual(result, {
    reason: "eligible_exhausted",
    selected: 3,
    added: 2,
    skipped: 1,
    preCount: 0,
    postCount: 2,
  });
  assert.equal(posts, 3);
  assert.deepEqual(marked, [1n]);
  assert.match(progress, /HTTP 200, bili code 90002/);
});

test("empirical add stops on capacity without marking the candidate", async () => {
  const marked: bigint[] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n];
      },
      async markWatchLaterEmpiricalFailedAid(aid) {
        marked.push(aid);
        return true;
      },
    },
    account([snapshot([])], [90001]),
    async () => {},
  );

  assert.deepEqual(result, {
    reason: "request_failed",
    selected: 1,
    added: 0,
    skipped: 0,
    preCount: 0,
    postCount: 0,
    error: "bili code 90001",
  });
  assert.deepEqual(marked, []);
});

test("empirical add test stops after twenty consecutive failed adds", async () => {
  const marked: bigint[] = [];
  const failingAccount = account([snapshot([]), snapshot([])]);
  failingAccount.toViewClient.post = async () => {
    throw { status: 200, data: { code: -400, message: "rejected" } };
  };
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return Array.from({ length: 21 }, (_, index) => BigInt(index + 1));
      },
      async markWatchLaterEmpiricalFailedAid(aid) {
        marked.push(aid);
        return true;
      },
    },
    failingAccount,
    async () => {},
  );

  assert.equal(result.reason, "request_failed");
  assert.equal(result.selected, 20);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 20);
  assert.equal(marked.length, 20);
  assert.equal(result.error, "HTTP 200, bili code -400, rejected");
});

test("empirical add test resets consecutive failures after a successful add", async () => {
  let posts = 0;
  const marked: bigint[] = [];
  const resetAccount = account([
    snapshot([]),
    snapshot([]),
    snapshot([20]),
    snapshot([20]),
  ]);
  resetAccount.toViewClient.post = async () => {
    posts += 1;
    if (posts === 20) return { data: { code: 0 } };
    throw { status: 200, data: { code: -400, message: "rejected" } };
  };
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return Array.from({ length: 21 }, (_, index) => BigInt(index + 1));
      },
      async markWatchLaterEmpiricalFailedAid(aid) {
        marked.push(aid);
        return true;
      },
    },
    resetAccount,
    async () => {},
  );

  assert.equal(result.reason, "eligible_exhausted");
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 20);
  assert.equal(posts, 21);
  assert.equal(marked.length, 20);
});

test("empirical add test logs the Bilibili response error before skipping", async () => {
  const failingAccount = account([snapshot([]), snapshot([])]);
  failingAccount.toViewClient.post = async () => {
    throw {
      status: 400,
      code: 400,
      data: { code: -101, message: "账号未登录" },
    };
  };
  let progress = "";
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [2n];
      },
      async markWatchLaterEmpiricalFailedAid() {
        return true;
      },
    },
    failingAccount,
    async () => {},
    (text) => {
      progress += text;
    },
  );

  assert.equal(result.reason, "eligible_exhausted");
  assert.equal(result.skipped, 1);
  assert.match(progress, /HTTP 400, bili code -101, 账号未登录/);
});

test("Watch Later transport failures dispatch each mutation once", async () => {
  const directory = mkdtempSync("/tmp/hantang-watch-later-");
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync("bili_jct=test", "https://www.bilibili.com/");
  const stateManager = new StateManager(join(directory, "state.json"));
  stateManager.updateTicket("test", Math.floor(Date.now() / 1000) + 7_200);
  stateManager.updateWbiKeys(
    "test",
    "test",
    Math.floor(Date.now() / 1000) + 7_200,
  );
  const client = createAccountToViewClient(
    cookieJar,
    join(directory, "cookies.txt"),
    stateManager,
  );
  const dispatches = { add: 0, del: 0, retryingGet: 0 };
  client.defaults.adapter = async (request) => {
    if (request.url === "/retry") {
      dispatches.retryingGet += 1;
      if (dispatches.retryingGet === 1) {
        const error = new Error("connection lost") as Error & {
          config: typeof request;
        };
        error.config = request;
        throw error;
      }
      return {
        data: { code: 0 },
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    }
    if (request.method === "get") {
      return {
        data: snapshot([]),
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    }
    assert.equal((request as RequestConfig).noRetry, true);
    if (request.url === "/add") dispatches.add += 1;
    if (request.url === "/del") dispatches.del += 1;
    const error = new Error("connection lost") as Error & {
      config: typeof request;
    };
    error.config = request;
    throw error;
  };
  const realClientAccount: WatchLaterAccountContext = {
    uid: "7",
    cookieJar,
    enableWatchLater: true,
    toViewClient: client,
  };

  try {
    const result = await runWatchLaterEmpiricalAddTest(
      {
        async getWatchLaterEligibleAids() {
          return [2n];
        },
        async markWatchLaterEmpiricalFailedAid() {
          return true;
        },
      },
      realClientAccount,
      async () => {},
    );
    assert.equal(result.reason, "eligible_exhausted");
    assert.equal(result.skipped, 1);
    assert.equal(dispatches.add, 1);
    await assert.rejects(() =>
      mutateWatchLater(realClientAccount, 3n, "delete"),
    );
    assert.equal(dispatches.del, 1);
    const originalRetryTimes = config.application.apiRetryTimes;
    config.application.apiRetryTimes = 0;
    try {
      await client.get("/retry");
    } finally {
      config.application.apiRetryTimes = originalRetryTimes;
    }
    assert.equal(dispatches.retryingGet, 2);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("empirical add test reports eligible exhaustion after verifying the post snapshot", async () => {
  let candidateQueries = 0;
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        candidateQueries += 1;
        return [1n, 2n];
      },
    } satisfies WatchLaterEmpiricalDatabase,
    account(
      [
        { code: 0, data: { count: 1, list: [item(1)] } },
        { code: 0, data: { count: 2, list: [item(1), item(2)] } },
      ],
      [0],
    ),
    async () => {},
  );
  assert.equal(result.reason, "eligible_exhausted");
  assert.equal(result.added, 1);
  assert.equal(candidateQueries, 1);
});

test("empirical additions settle after the final post before verification", async () => {
  const delays: number[] = [];
  let progress = "";
  let maxPriorityExclusive = 0;
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids(maxPriority) {
        maxPriorityExclusive = maxPriority;
        return [2n, 3n];
      },
    },
    account(
      [
        { code: 0, data: { count: 0, list: [] } },
        { code: 0, data: { count: 2, list: [item(2), item(3)] } },
      ],
      [0, 0],
    ),
    async (milliseconds) => {
      delays.push(milliseconds);
    },
    (text) => {
      progress += text;
    },
    20,
  );
  assert.equal(result.added, 2);
  assert.equal(maxPriorityExclusive, 20);
  assert.deepEqual(delays, [1000, 3000]);
  assert.equal(
    progress,
    "priority<20 targets: 2, present: 0, missing: 2, watch-later total: 0\nadding 1 to 2: ..\n",
  );
});

test("empirical run processes two full batches and reuses each post snapshot", async () => {
  let getCount = 0;
  const initial = [1];
  const firstBatch = Array.from({ length: 10 }, (_, index) => index + 2);
  const secondBatch = Array.from({ length: 10 }, (_, index) => index + 12);
  let candidateQueries = 0;
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        candidateQueries += 1;
        return [...firstBatch, ...secondBatch].map(BigInt);
      },
    },
    account(
      [
        snapshot(initial),
        snapshot([...initial, ...firstBatch]),
        snapshot([...initial, ...firstBatch, ...secondBatch]),
      ],
      [],
      "7",
      () => {
        getCount += 1;
      },
    ),
    async () => {},
  );

  assert.equal(result.reason, "eligible_exhausted");
  assert.deepEqual(result, {
    reason: "eligible_exhausted",
    selected: 20,
    added: 20,
    skipped: 0,
    preCount: 1,
    postCount: 21,
  });
  assert.equal(getCount, 3);
  assert.equal(candidateQueries, 1);
});

test("empirical run completes a partial final batch with aggregate pacing", async () => {
  const firstBatch = Array.from({ length: 10 }, (_, index) => index + 1);
  const finalBatch = [11, 12];
  const delays: number[] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [...firstBatch, ...finalBatch].map(BigInt);
      },
    },
    account(
      [
        snapshot([]),
        snapshot(firstBatch),
        snapshot([...firstBatch, ...finalBatch]),
      ],
      [],
    ),
    async (milliseconds) => {
      delays.push(milliseconds);
    },
  );

  assert.deepEqual(result, {
    reason: "eligible_exhausted",
    selected: 12,
    added: 12,
    skipped: 0,
    preCount: 0,
    postCount: 12,
  });
  assert.deepEqual(delays, [...Array(9).fill(1000), 3000, 1000, 3000]);
});

test("empirical run reports post-snapshot and verification failures", async () => {
  const postSnapshotFailure = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n];
      },
    },
    account([snapshot([]), { code: -400 }], [0]),
    async () => {},
  );
  const verificationFailure = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n];
      },
    },
    account([snapshot([]), snapshot([])], [0]),
    async () => {},
  );

  assert.equal(postSnapshotFailure.reason, "post_snapshot_failed");
  assert.equal(verificationFailure.reason, "verification_failed");
});

test("ambiguous mutation is retained and stops further operations", async () => {
  let posts = 0;
  const classifications: string[] = [];
  const failingAccount = account([{ code: 0, data: { count: 0, list: [] } }]);
  failingAccount.toViewClient.post = async () => {
    posts += 1;
    throw new Error("connection lost");
  };
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n, 2n], overflow: false };
      },
      async resolveWatchLaterOperation(input) {
        classifications.push(input.resultClassification);
        return true;
      },
    }),
    failingAccount,
    configured,
    async () => {},
    2,
  );
  assert.equal(posts, 1);
  assert.deepEqual(classifications, ["ambiguous"]);
  assert.equal(result.added, 0);
});

test("Watch Later metrics report startup layout and reconciliation outcomes", async () => {
  watchLaterEnabledAccounts.reset();
  watchLaterCapacity.reset();
  watchLaterAccountSlotItems.reset();
  watchLaterMutationsTotal.reset();
  watchLaterReconciliationsTotal.reset();

  await runAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n], overflow: false };
        },
      }),
      async getWatchLaterAccounts() {
        return [configured, { ...configured, accountId: 8n }];
      },
    },
    [account([snapshot([])]), account([{ code: -101 }], [], "8")],
    2,
  );
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
    }),
    account([snapshot([])]),
    configured,
    async () => {},
    1,
  );
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
    }),
    account([snapshot([])], [-400]),
    configured,
    async () => {},
    1,
  );
  const ambiguousAccount = account([snapshot([])]);
  ambiguousAccount.toViewClient.post = async () => {
    throw new Error("connection lost");
  };
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
    }),
    ambiguousAccount,
    configured,
    async () => {},
    1,
  );
  await reconcileWatchLaterAccount(
    database(),
    account([{ code: -101 }]),
    configured,
    async () => {},
    1,
  );
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
    }),
    account([snapshot([])], [90001]),
    configured,
    async () => {},
    1,
  );
  await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [], overflow: true };
      },
    }),
    account([snapshot([])]),
    configured,
    async () => {},
    1,
  );

  assert.deepEqual((await watchLaterEnabledAccounts.get()).values, [
    { labels: { state: "healthy" }, value: 1 },
    { labels: { state: "unavailable" }, value: 1 },
  ]);
  assert.deepEqual((await watchLaterCapacity.get()).values, [
    { labels: { pool: "total" }, value: 2 },
    { labels: { pool: "priority" }, value: 1 },
    { labels: { pool: "newest" }, value: 1 },
  ]);
  assert.deepEqual((await watchLaterAccountSlotItems.get()).values, [
    { labels: { account_slot: "0", kind: "assigned" }, value: 1 },
    { labels: { account_slot: "0", kind: "observed" }, value: 1 },
    { labels: { account_slot: "0", kind: "remaining_delete" }, value: 0 },
    { labels: { account_slot: "0", kind: "remaining_add" }, value: 0 },
  ]);
  assert.deepEqual(
    (await watchLaterMutationsTotal.get()).values.sort((left, right) =>
      JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)),
    ),
    [
      { labels: { action: "add", outcome: "ambiguous" }, value: 1 },
      { labels: { action: "add", outcome: "capacity_blocked" }, value: 1 },
      { labels: { action: "add", outcome: "failed" }, value: 1 },
      { labels: { action: "add", outcome: "succeeded" }, value: 2 },
    ],
  );
  assert.deepEqual((await watchLaterReconciliationsTotal.get()).values, [
    { labels: { outcome: "completed" }, value: 5 },
    { labels: { outcome: "snapshot_invalid" }, value: 1 },
    { labels: { outcome: "desired_overflow" }, value: 1 },
  ]);
});
