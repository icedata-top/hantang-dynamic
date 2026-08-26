import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import type {
  WatchLaterAccount,
  WatchLaterAccountLease,
} from "../../database/watchLater";
import type { WatchLaterAccountContext } from "./watchLaterApi";
import {
  partitionDesiredWatchLaterAids,
  runAutomaticWatchLaterManagement,
  type WatchLaterDatabase,
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

function snapshot(aids: number[]) {
  return { code: 0, data: { count: aids.length, list: aids.map(item) } };
}

function account(
  snapshots: Array<ReturnType<typeof snapshot>>,
  mutationCodes: number[] = [],
  uid = "7",
  actions: string[] = [],
): WatchLaterAccountContext {
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync("bili_jct=test", "https://www.bilibili.com/");
  return {
    uid,
    cookieJar,
    enableWatchLater: true,
    toViewClient: {
      async get() {
        const response = snapshots.shift();
        if (!response) throw new Error("missing snapshot");
        return { data: response };
      },
      async post(url, body) {
        actions.push(`${url}:${body.get("aid")}`);
        return { data: { code: mutationCodes.shift() ?? 0 } };
      },
    },
  };
}

function database(
  overrides: Partial<WatchLaterDatabase> & {
    getWatchLaterAccounts?(accountIds: bigint[]): Promise<WatchLaterAccount[]>;
  } = {},
): WatchLaterDatabase & {
  getWatchLaterAccounts(accountIds: bigint[]): Promise<WatchLaterAccount[]>;
} {
  return {
    async getDesiredWatchLaterSet() {
      return { aids: [], overflow: false };
    },
    async getWatchLaterAccounts() {
      return [{ accountId: 7n, lastCompleteSnapshotAt: null }];
    },
    async syncWatchLaterSnapshot() {
      return 0;
    },
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

test("assigns each desired AID once in deterministic capacity-bounded order", () => {
  for (const accountCount of [1, 2, 3]) {
    const desired = Array.from({ length: accountCount * 1_000 + 2 }, (_, i) =>
      BigInt(i + 1),
    );
    const assignments = partitionDesiredWatchLaterAids(desired, accountCount);
    assert.equal(assignments.flat().length, accountCount * 1_000);
    assert.equal(
      new Set(assignments.flat().map(String)).size,
      accountCount * 1_000,
    );
    assert.deepEqual(assignments[0]?.slice(0, 3), [
      1n,
      BigInt(accountCount + 1),
      BigInt(accountCount * 2 + 1),
    ]);
  }
});

test("syncs healthy snapshots, deletes globally before adding, and shares pacing", async () => {
  const actions: string[] = [];
  const delays: number[] = [];
  let target = 0;
  const result = await runAutomaticWatchLaterManagement(
    database({
      async getWatchLaterAccounts() {
        return [
          { accountId: 7n, lastCompleteSnapshotAt: null },
          { accountId: 8n, lastCompleteSnapshotAt: null },
        ];
      },
      async getDesiredWatchLaterSet(requested) {
        target = requested;
        return { aids: [1n, 2n, 3n, 4n], overflow: false };
      },
    }),
    [
      account([snapshot([90])], [], "7", actions),
      account([snapshot([91])], [], "8", actions),
    ],
    2,
    {
      async delay(ms) {
        delays.push(ms);
      },
    },
  );
  assert.equal(target, 4);
  assert.deepEqual(actions, [
    "/del:90",
    "/del:91",
    "/add:1",
    "/add:3",
    "/add:2",
    "/add:4",
  ]);
  assert.deepEqual(delays, [1_000, 1_000, 1_000, 1_000, 1_000]);
  assert.equal(
    result.every((entry) => entry.reason === "completed"),
    true,
  );
});

test("invalid snapshots are unhealthy and publish no routing membership", async () => {
  const healthy: bigint[][] = [];
  let synced = 0;
  await runAutomaticWatchLaterManagement(
    database({
      async syncWatchLaterSnapshot() {
        synced += 1;
        return 0;
      },
    }),
    [account([{ code: 0, data: { count: 1, list: [] } }])],
    undefined,
    {
      onHealthyAccounts(ids) {
        healthy.push([...ids]);
      },
    },
  );
  assert.equal(synced, 0);
  assert.deepEqual(healthy, [[], []]);
});

test("sync failure excludes only that account from published routing health", async () => {
  const healthy: bigint[][] = [];
  await runAutomaticWatchLaterManagement(
    database({
      async getWatchLaterAccounts() {
        return [
          { accountId: 7n, lastCompleteSnapshotAt: null },
          { accountId: 8n, lastCompleteSnapshotAt: null },
        ];
      },
      async syncWatchLaterSnapshot(accountId) {
        if (accountId === 7n) throw new Error("database sync failed");
        return 0;
      },
    }),
    [account([snapshot([])], [], "7"), account([snapshot([])], [], "8")],
    undefined,
    {
      onHealthyAccounts(ids) {
        healthy.push([...ids]);
      },
    },
  );
  assert.deepEqual(healthy, [[], [8n]]);
});

test("deadline reached while paced prevents the next POST and leaves only snapshot state", async () => {
  const actions: string[] = [];
  let now = 0;
  const result = await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return { aids: [1n], overflow: false };
      },
    }),
    [account([snapshot([2])], [], "7", actions)],
    undefined,
    {
      now: () => now,
      async delay() {
        now = 14 * 60_000;
      },
    },
  );
  assert.deepEqual(actions, ["/del:2"]);
  assert.equal(result[result.length - 1]?.reason, "deadline");
});

test("capacity, ambiguous response, lease loss, and cancellation do not replay mutations", async () => {
  const cases: Array<{
    name: string;
    codes?: number[];
    renew?: boolean;
    stopDuringDelay?: boolean;
    reason: string;
  }> = [
    { name: "capacity", codes: [90001], reason: "capacity_blocked" },
    { name: "ambiguous", codes: [90002], reason: "ambiguous" },
    { name: "lease", renew: false, reason: "lease_lost" },
    { name: "stopped", stopDuringDelay: true, reason: "stopped" },
  ];
  for (const scenario of cases) {
    const actions: string[] = [];
    let running = true;
    const result = await runAutomaticWatchLaterManagement(
      database({
        async getDesiredWatchLaterSet() {
          return { aids: [1n, 2n], overflow: false };
        },
        async withWatchLaterAccountLease<T>(
          _id: bigint,
          callback: (lease: WatchLaterAccountLease) => Promise<T>,
        ) {
          return callback({
            async renew() {
              return scenario.renew ?? true;
            },
          });
        },
      }),
      [account([snapshot([])], scenario.codes, "7", actions)],
      undefined,
      {
        shouldContinue: () => running,
        async delay() {
          if (scenario.stopDuringDelay) running = false;
        },
      },
    );
    assert.equal(
      result[result.length - 1]?.reason,
      scenario.reason,
      scenario.name,
    );
    assert.equal(
      actions.length,
      scenario.stopDuringDelay ? 1 : scenario.renew === false ? 0 : 1,
      scenario.name,
    );
  }
});
