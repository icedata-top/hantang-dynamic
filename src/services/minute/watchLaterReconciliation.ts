import type {
  WatchLaterAccount,
  WatchLaterAccountLease,
  WatchLaterAction,
} from "../../database/watchLater";
import {
  watchLaterEnabledAccounts,
  watchLaterMutationsTotal,
  watchLaterReconciliationsTotal,
} from "../../metrics/registry";
import { sleep } from "../../utils/datetime";
import {
  fetchWatchLaterSnapshot,
  mutateWatchLater,
  type WatchLaterAccountContext,
  WatchLaterMutationPrePostAbortError,
  type WatchLaterSnapshot,
} from "./watchLaterApi";

export const WATCH_LATER_CAPACITY = 1_000;
const MUTATION_DELAY_MS = 1_000;
const CYCLE_DEADLINE_MS = 14 * 60_000;
type Delay = (milliseconds: number) => Promise<void>;

export interface WatchLaterDatabase {
  getDesiredWatchLaterSet(
    targetCount: number,
  ): Promise<{ aids: bigint[]; overflow: boolean }>;
  syncWatchLaterSnapshot(
    accountId: bigint,
    aids: bigint[],
    completedAt: Date,
  ): Promise<number>;
  withWatchLaterAccountLease<T>(
    accountId: bigint,
    callback: (lease: WatchLaterAccountLease) => Promise<T>,
  ): Promise<T>;
}

export interface WatchLaterReconciliationResult {
  reason:
    | "completed"
    | "snapshot_invalid"
    | "deadline"
    | "lease_lost"
    | "stopped"
    | "ambiguous";
  added: number;
  deleted: number;
}

export interface WatchLaterManagementOptions {
  shouldContinue?(): boolean;
  delay?: Delay;
  now?(): number;
  onHealthyAccounts?(accountIds: ReadonlySet<bigint>): void;
}

function accountId(account: { uid: string }): bigint | null {
  return /^\d+$/.test(account.uid) ? BigInt(account.uid) : null;
}

function createPacer(
  delay: Delay,
): (action: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve();
  let used = false;
  return async (action) => {
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (used) await delay(MUTATION_DELAY_MS);
      used = true;
      await action();
    } finally {
      release();
    }
  };
}

async function reconcileAccount(
  database: WatchLaterDatabase,
  account: WatchLaterAccountContext,
  row: WatchLaterAccount,
  desiredAids: readonly bigint[],
  snapshot: WatchLaterSnapshot,
  pace: (action: () => Promise<void>) => Promise<void>,
  deadline: number,
  now: () => number,
  phase: "delete" | "add" | "all" = "all",
  shouldContinue?: () => boolean,
): Promise<WatchLaterReconciliationResult> {
  return database.withWatchLaterAccountLease(row.accountId, async (lease) => {
    const desired = new Set(desiredAids.map(String));
    const deletes = [...snapshot.aids]
      .filter((aid) => !desired.has(aid))
      .map(BigInt);
    const adds = desiredAids.filter(
      (aid) => !snapshot.aids.has(aid.toString()),
    );
    let added = 0;
    let deleted = 0;
    const mutate = async (
      action: WatchLaterAction,
      aid: bigint,
    ): Promise<WatchLaterReconciliationResult["reason"] | undefined> => {
      if (now() >= deadline) return "deadline";
      if (shouldContinue && !shouldContinue()) return "stopped";
      let code: number | undefined;
      try {
        await pace(async () => {
          code = await mutateWatchLater(account, aid, action, {
            async beforePost() {
              if (now() >= deadline) return "deadline";
              if (shouldContinue && !shouldContinue()) return "stopped";
              return (await lease.renew()) ? undefined : "lease_lost";
            },
          });
        });
      } catch (error) {
        if (error instanceof WatchLaterMutationPrePostAbortError) {
          if (error.reason === "deadline") return "deadline";
          return error.reason === "stopped" ? "stopped" : "lease_lost";
        }
        watchLaterMutationsTotal.inc({ action, outcome: "ambiguous" });
        return "ambiguous";
      }
      if (code === 0) {
        watchLaterMutationsTotal.inc({ action, outcome: "succeeded" });
        if (action === "add") added += 1;
        else deleted += 1;
        return undefined;
      }
      watchLaterMutationsTotal.inc({ action, outcome: "failed" });
      return "ambiguous";
    };
    for (const aid of phase === "add" ? [] : deletes) {
      const reason = await mutate("delete", aid);
      if (reason) return { reason, added, deleted };
    }
    for (const aid of phase === "delete" ? [] : adds) {
      const reason = await mutate("add", aid);
      if (reason) return { reason, added, deleted };
    }
    return { reason: "completed", added, deleted };
  });
}

export function partitionDesiredWatchLaterAids(
  desiredAids: bigint[],
  accountCount: number,
  capacity = WATCH_LATER_CAPACITY,
): bigint[][] {
  const assignments = Array.from(
    { length: Math.max(0, accountCount) },
    () => [] as bigint[],
  );
  const seen = new Set<string>();
  for (const aid of desiredAids) {
    if (seen.has(aid.toString()) || seen.size >= accountCount * capacity)
      continue;
    seen.add(aid.toString());
    assignments[(seen.size - 1) % accountCount]?.push(aid);
  }
  return assignments;
}

export async function runAutomaticWatchLaterManagement(
  database: WatchLaterDatabase & {
    getWatchLaterAccounts(accountIds: bigint[]): Promise<WatchLaterAccount[]>;
  },
  accounts: WatchLaterAccountContext[],
  capacity = WATCH_LATER_CAPACITY,
  options: WatchLaterManagementOptions = {},
): Promise<WatchLaterReconciliationResult[]> {
  watchLaterEnabledAccounts.reset();
  watchLaterEnabledAccounts.set({ state: "healthy" }, 0);
  watchLaterEnabledAccounts.set({ state: "unhealthy" }, 0);
  options.onHealthyAccounts?.(new Set());
  const enabled = accounts.flatMap((account) =>
    account.enableWatchLater && accountId(account) !== null
      ? [[accountId(account) as bigint, account] as const]
      : [],
  );
  const rows = await database.getWatchLaterAccounts(enabled.map(([id]) => id));
  const byId = new Map(enabled);
  const healthy: Array<{
    account: WatchLaterAccountContext;
    row: WatchLaterAccount;
    snapshot: WatchLaterSnapshot;
  }> = [];
  for (const row of rows) {
    const account = byId.get(row.accountId);
    if (!account) continue;
    try {
      const snapshot = await fetchWatchLaterSnapshot(account.toViewClient);
      if (!snapshot) continue;
      await database.syncWatchLaterSnapshot(
        row.accountId,
        [...snapshot.aids].map(BigInt),
        snapshot.completedAt,
      );
      healthy.push({ account, row, snapshot });
    } catch {}
  }
  watchLaterEnabledAccounts.reset();
  watchLaterEnabledAccounts.set({ state: "healthy" }, healthy.length);
  watchLaterEnabledAccounts.set(
    { state: "unhealthy" },
    rows.length - healthy.length,
  );
  options.onHealthyAccounts?.(
    new Set(healthy.map((item) => item.row.accountId)),
  );
  if (healthy.length === 0) return [];
  const desired = await database.getDesiredWatchLaterSet(
    healthy.length * capacity,
  );
  if (desired.overflow) return [];
  const assignments = partitionDesiredWatchLaterAids(
    desired.aids,
    healthy.length,
    capacity,
  );
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + CYCLE_DEADLINE_MS;
  const pace = createPacer(delay);
  const results: WatchLaterReconciliationResult[] = [];
  for (const phase of ["delete", "add"] as const) {
    for (const [index, item] of healthy.entries()) {
      try {
        const result = await reconcileAccount(
          database,
          item.account,
          item.row,
          assignments[index] ?? [],
          item.snapshot,
          pace,
          deadline,
          now,
          phase,
          options.shouldContinue,
        );
        results.push(result);
        watchLaterReconciliationsTotal.inc({ outcome: result.reason });
        if (result.reason !== "completed") return results;
      } catch {
        watchLaterReconciliationsTotal.inc({ outcome: "lease_lost" });
        return results;
      }
    }
  }
  return results;
}
