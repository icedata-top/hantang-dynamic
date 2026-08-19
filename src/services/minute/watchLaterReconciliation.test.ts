import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import type { WatchLaterAccount } from "../../database/watchLater";
import type { WatchLaterAccountContext } from "./watchLaterApi";
import {
  reconcileWatchLaterAccount,
  runAutomaticWatchLaterManagement,
  runWatchLaterEmpiricalAddTest,
  selectWatchLaterEmpiricalAccount,
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
  let desiredCall = 0;
  const results = await runAutomaticWatchLaterManagement(
    {
      ...database({
        async getDesiredWatchLaterSet(target) {
          assert.equal(target, 2);
          desiredCall += 1;
          return { aids: [BigInt(desiredCall)], overflow: false };
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
  assert.deepEqual(operations, [
    { accountId: 7n, aid: 1n },
    { accountId: 8n, aid: 2n },
  ]);
});

test("zero capacity samples the remote snapshot without posting mutations", async () => {
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
  );
  assert.equal(result.reason, "completed");
  assert.equal(requestedTarget, -1);
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

test("empirical add test stops on an add request failure", async () => {
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [2n, 3n];
      },
    } satisfies WatchLaterEmpiricalDatabase,
    account([{ code: 0, data: { count: 0, list: [] } }], [0, -400]),
    async () => {},
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

test("empirical additions use the reconciliation delay between successful posts", async () => {
  const delays: number[] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
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
  );
  assert.equal(result.added, 2);
  assert.deepEqual(delays, [1000]);
});

test("empirical run processes two full batches and reuses each post snapshot", async () => {
  let getCount = 0;
  const initial = [1];
  const firstBatch = Array.from({ length: 10 }, (_, index) => index + 2);
  const secondBatch = Array.from({ length: 10 }, (_, index) => index + 12);
  const exclusions: bigint[][] = [];
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids(excluded) {
        exclusions.push(excluded);
        if (exclusions.length === 1) return firstBatch.map(BigInt);
        if (exclusions.length === 2) return secondBatch.map(BigInt);
        return [];
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
    preCount: 1,
    postCount: 21,
  });
  assert.equal(getCount, 3);
  assert.deepEqual(exclusions[1], [...initial, ...firstBatch].map(BigInt));
});

test("empirical run completes a partial final batch with aggregate pacing", async () => {
  const firstBatch = Array.from({ length: 10 }, (_, index) => index + 1);
  const finalBatch = [11, 12];
  const delays: number[] = [];
  let batch = 0;
  const result = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        batch += 1;
        return batch === 1 ? firstBatch.map(BigInt) : finalBatch.map(BigInt);
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
    preCount: 0,
    postCount: 12,
  });
  assert.deepEqual(delays, Array(11).fill(1000));
});

test("empirical run reports post-snapshot and verification failures", async () => {
  const postSnapshotFailure = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n];
      },
    },
    account([snapshot([]), { code: -400 }], [0]),
  );
  const verificationFailure = await runWatchLaterEmpiricalAddTest(
    {
      async getWatchLaterEligibleAids() {
        return [1n];
      },
    },
    account([snapshot([]), snapshot([])], [0]),
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
