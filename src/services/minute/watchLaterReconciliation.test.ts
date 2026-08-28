import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import {
  watchLaterEnabledAccounts,
  watchLaterReconciliationsTotal,
} from "../../metrics/registry";
import type { WatchLaterAccountContext } from "./watchLaterApi";
import {
  partitionDesiredWatchLaterAids,
  runAutomaticWatchLaterManagement,
  type WatchLaterDatabase,
} from "./watchLaterReconciliation";

function item(aid: number, pidV2?: number) {
  return {
    aid,
    ...(pidV2 === undefined ? {} : { pid_v2: pidV2 }),
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

function snapshot(aids: number[], pidV2ByAid: Map<number, number> = new Map()) {
  return {
    code: 0,
    data: {
      count: aids.length,
      list: aids.map((aid) => item(aid, pidV2ByAid.get(aid))),
    },
  };
}

function account(
  snapshots: Array<ReturnType<typeof snapshot>>,
  mutationResults: Array<number | Error> = [],
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
        const result = mutationResults.shift() ?? 0;
        if (result instanceof Error) throw result;
        return { data: { code: result } };
      },
    },
  };
}

function database(
  overrides: Partial<WatchLaterDatabase> = {},
): WatchLaterDatabase {
  return {
    async getDesiredWatchLaterSet() {
      return [];
    },
    async syncWatchLaterSnapshot() {
      return 0;
    },
    ...overrides,
  };
}

async function metricValue(
  metric: {
    get(): Promise<{ values: Array<{ labels: object; value: number }> }>;
  },
  labels: object,
): Promise<number | undefined> {
  const { values } = await metric.get();
  return values.find(
    (entry) => JSON.stringify(entry.labels) === JSON.stringify(labels),
  )?.value;
}

test("assigns each desired AID once in deterministic capacity-bounded order", () => {
  for (const accountCount of [1, 2, 3]) {
    const desired = Array.from({ length: accountCount * 980 + 2 }, (_, i) =>
      BigInt(i + 1),
    );
    const assignments = partitionDesiredWatchLaterAids(desired, accountCount);
    assert.equal(assignments.flat().length, accountCount * 980);
    assert.equal(
      new Set(assignments.flat().map(String)).size,
      accountCount * 980,
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
  const metadata: Array<ReadonlyArray<{ aid: bigint; pidV2: number }>> = [];
  let target = 0;
  const result = await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet(requested) {
        target = requested;
        return [1n, 2n, 3n, 4n];
      },
      async syncWatchLaterSnapshot(_accountId, _aids, pidV2Metadata) {
        metadata.push(pidV2Metadata);
        return 0;
      },
    }),
    [
      account([snapshot([90], new Map([[90, 22]]))], [], "7", actions),
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
  assert.deepEqual(metadata, [[{ aid: 90n, pidV2: 22 }], []]);
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
        return [1n];
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

test("capacity, ambiguous response, and cancellation do not replay mutations", async () => {
  const cases: Array<{
    name: string;
    codes?: number[];
    stopDuringDelay?: boolean;
    reason: string;
  }> = [
    { name: "capacity", codes: [90001], reason: "capacity_blocked" },
    { name: "ambiguous", codes: [90002], reason: "ambiguous" },
    { name: "stopped", stopDuringDelay: true, reason: "stopped" },
  ];
  for (const scenario of cases) {
    const actions: string[] = [];
    let running = true;
    const result = await runAutomaticWatchLaterManagement(
      database({
        async getDesiredWatchLaterSet() {
          return [1n, 2n];
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
    assert.equal(actions.length, 1, scenario.name);
  }
});

test("add failures do not prevent later healthy accounts from reconciling", async () => {
  const actions: string[] = [];
  const result = await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return [1n, 2n, 3n];
      },
    }),
    [
      account([snapshot([])], [90001], "7", actions),
      account([snapshot([])], [new Error("network failure")], "8", actions),
      account([snapshot([])], [], "9", actions),
    ],
    undefined,
    { async delay() {} },
  );

  assert.deepEqual(actions, ["/add:1", "/add:2", "/add:3"]);
  assert.deepEqual(
    result.map((entry) => entry.reason),
    [
      "completed",
      "completed",
      "completed",
      "capacity_blocked",
      "ambiguous",
      "completed",
    ],
  );
});

test("delete failure suppresses remaining deletes and all additions", async () => {
  const actions: string[] = [];
  const result = await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return [1n, 2n];
      },
    }),
    [
      account([snapshot([90])], [new Error("network failure")], "7", actions),
      account([snapshot([91])], [], "8", actions),
    ],
    undefined,
    { async delay() {} },
  );

  assert.deepEqual(actions, ["/del:90"]);
  assert.deepEqual(
    result.map((entry) => entry.reason),
    ["ambiguous"],
  );
});

test("publishes account health only after a scan completes", async () => {
  watchLaterEnabledAccounts.reset();
  watchLaterEnabledAccounts.set({ state: "healthy" }, 2);
  watchLaterEnabledAccounts.set({ state: "unhealthy" }, 1);
  let finishScan!: () => void;
  const scanBlocked = new Promise<void>((resolve) => {
    finishScan = resolve;
  });
  const context = account([], [], "7");
  context.toViewClient.get = async () => {
    await scanBlocked;
    return { data: snapshot([]) };
  };

  const running = runAutomaticWatchLaterManagement(database(), [context]);
  await Promise.resolve();
  assert.equal(
    await metricValue(watchLaterEnabledAccounts, { state: "healthy" }),
    2,
  );
  assert.equal(
    await metricValue(watchLaterEnabledAccounts, { state: "unhealthy" }),
    1,
  );

  finishScan();
  await running;
  assert.equal(
    await metricValue(watchLaterEnabledAccounts, { state: "healthy" }),
    1,
  );
  assert.equal(
    await metricValue(watchLaterEnabledAccounts, { state: "unhealthy" }),
    0,
  );
  watchLaterEnabledAccounts.reset();
});

test("counts one final reconciliation outcome per cycle", async () => {
  watchLaterReconciliationsTotal.reset();
  await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return [1n, 2n];
      },
    }),
    [account([snapshot([])], [90001], "7"), account([snapshot([])], [], "8")],
    undefined,
    { async delay() {} },
  );
  await runAutomaticWatchLaterManagement(database(), []);
  await runAutomaticWatchLaterManagement(database(), [
    account([snapshot([])], [], "7"),
  ]);
  let nowCalls = 0;
  await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return [1n];
      },
    }),
    [account([snapshot([])], [], "7")],
    undefined,
    { now: () => (nowCalls++ === 0 ? 0 : 14 * 60_000) },
  );
  await runAutomaticWatchLaterManagement(
    database({
      async getDesiredWatchLaterSet() {
        return [1n];
      },
    }),
    [account([snapshot([])], [], "7")],
    undefined,
    { shouldContinue: () => false },
  );
  await assert.rejects(
    runAutomaticWatchLaterManagement(
      database({
        async getDesiredWatchLaterSet() {
          throw new Error("query failed");
        },
      }),
      [account([snapshot([])], [], "7")],
    ),
    /query failed/,
  );

  const { values } = await watchLaterReconciliationsTotal.get();
  assert.deepEqual(
    Object.fromEntries(
      values.map(({ labels, value }) => [labels.outcome, value]),
    ),
    {
      completed: 1,
      deadline: 1,
      internal_failure: 1,
      no_healthy_accounts: 1,
      partial: 1,
      stopped: 1,
    },
  );
  watchLaterReconciliationsTotal.reset();
});
