import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import type { WatchLaterAccount } from "../../database/watchLater";
import type { WatchLaterAccountContext } from "./watchLaterApi";
import {
  reconcileWatchLaterAccount,
  runAutomaticWatchLaterManagement,
  runWatchLaterEmpiricalAddTest,
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
): WatchLaterAccountContext {
  return {
    uid: "7",
    cookieJar: new CookieJar(),
    toViewClient: {
      async get() {
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
      callback: () => Promise<T>,
    ) {
      return callback();
    },
    ...overrides,
  };
}

const configured: WatchLaterAccount = {
  accountId: 7n,
  enabled: true,
  targetCount: 9,
  remoteCapacity: null,
  capacityBlockedAt: null,
  requiresCompleteRefetch: false,
  lastCompleteSnapshotAt: null,
};

test("automatic management has one disabled capacity gate and performs no account lookup", async () => {
  let lookedUp = false;
  const result = await runAutomaticWatchLaterManagement(
    {
      ...database(),
      async getEnabledWatchLaterAccounts() {
        lookedUp = true;
        return [configured];
      },
    },
    [],
  );
  assert.deepEqual(result, []);
  assert.equal(lookedUp, false);
});

test("each configured account uses its own target constrained by the configured capacity", async () => {
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
    4,
  );
  assert.equal(result.reason, "completed");
  assert.equal(requestedTarget, 4);
});

test("each account respects its recorded remote capacity", async () => {
  let requestedTarget = -1;
  const result = await reconcileWatchLaterAccount(
    database({
      async getDesiredWatchLaterSet(target) {
        requestedTarget = target;
        return { aids: [], overflow: false };
      },
    }),
    account([{ code: 0, data: { count: 0, list: [] } }]),
    { ...configured, remoteCapacity: 2 },
    4,
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
    2,
  );
  assert.equal(result.added, 1);
  assert.deepEqual(attemptedAids, [2n]);
});

test("empirical add test stops on an add request failure", async () => {
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [2n, 3n];
      },
    } satisfies WatchLaterEmpiricalDatabase,
    account([{ code: 0, data: { count: 0, list: [] } }], [0, -400]),
  );
  assert.equal(result.reason, "request_failed");
  assert.equal(result.added, 1);
});

test("empirical add test reports eligible exhaustion after verifying the post snapshot", async () => {
  let excludedAids: bigint[] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids(excluded) {
        excludedAids = excluded;
        return [2n];
      },
    } satisfies WatchLaterEmpiricalDatabase,
    account(
      [
        { code: 0, data: { count: 1, list: [item(1)] } },
        { code: 0, data: { count: 2, list: [item(1), item(2)] } },
      ],
      [0],
    ),
  );
  assert.equal(result.reason, "eligible_exhausted");
  assert.equal(result.added, 1);
  assert.deepEqual(excludedAids, [1n]);
});
