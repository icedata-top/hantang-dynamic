import type { WatchLaterAction } from "../../database/watchLater";
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

export const WATCH_LATER_CAPACITY = 980;
const MUTATION_DELAY_MS = 1_000;
const CYCLE_DEADLINE_MS = 14 * 60_000;
const CAPACITY_BLOCKED_CODE = 90001;
type Delay = (milliseconds: number) => Promise<void>;

export interface WatchLaterDatabase {
  getDesiredWatchLaterSet(targetCount: number): Promise<bigint[]>;
  syncWatchLaterSnapshot(
    accountId: bigint,
    aids: bigint[],
    pidV2Metadata: ReadonlyArray<{ aid: bigint; pidV2: number }>,
  ): Promise<number>;
}

export interface WatchLaterReconciliationResult {
  reason:
    | "completed"
    | "deadline"
    | "stopped"
    | "capacity_blocked"
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
  account: WatchLaterAccountContext,
  desiredAids: readonly bigint[],
  snapshot: WatchLaterSnapshot,
  pace: (action: () => Promise<void>) => Promise<void>,
  deadline: number,
  now: () => number,
  phase: "delete" | "add",
  shouldContinue?: () => boolean,
): Promise<WatchLaterReconciliationResult> {
  const desired = new Set(desiredAids.map(String));
  const deletes = [...snapshot.aids]
    .filter((aid) => !desired.has(aid))
    .map(BigInt);
  const adds = desiredAids.filter((aid) => !snapshot.aids.has(aid.toString()));
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
            return undefined;
          },
        });
      });
    } catch (error) {
      if (error instanceof WatchLaterMutationPrePostAbortError) {
        return error.reason;
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
    const reason =
      code === CAPACITY_BLOCKED_CODE ? "capacity_blocked" : "ambiguous";
    watchLaterMutationsTotal.inc({
      action,
      outcome: reason === "capacity_blocked" ? "capacity_blocked" : "failed",
    });
    return reason;
  };
  const aids = phase === "delete" ? deletes : adds;
  for (const aid of aids) {
    const reason = await mutate(phase, aid);
    if (reason) return { reason, added, deleted };
  }
  return { reason: "completed", added, deleted };
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
  database: WatchLaterDatabase,
  accounts: WatchLaterAccountContext[],
  capacity = WATCH_LATER_CAPACITY,
  options: WatchLaterManagementOptions = {},
): Promise<WatchLaterReconciliationResult[]> {
  watchLaterEnabledAccounts.reset();
  watchLaterEnabledAccounts.set({ state: "healthy" }, 0);
  watchLaterEnabledAccounts.set({ state: "unhealthy" }, 0);
  options.onHealthyAccounts?.(new Set());
  const enabledById = new Map<bigint, WatchLaterAccountContext>();
  for (const account of accounts) {
    const id = accountId(account);
    if (account.enableWatchLater && id !== null) {
      enabledById.set(id, account);
    }
  }
  const enabled = [...enabledById].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const healthy: Array<{
    accountId: bigint;
    account: WatchLaterAccountContext;
    snapshot: WatchLaterSnapshot;
  }> = [];
  for (const [id, account] of enabled) {
    try {
      const snapshot = await fetchWatchLaterSnapshot(account.toViewClient);
      if (!snapshot) continue;
      await database.syncWatchLaterSnapshot(
        id,
        [...snapshot.aids].map(BigInt),
        snapshot.pidV2Metadata,
      );
      healthy.push({ accountId: id, account, snapshot });
    } catch {}
  }
  watchLaterEnabledAccounts.reset();
  watchLaterEnabledAccounts.set({ state: "healthy" }, healthy.length);
  watchLaterEnabledAccounts.set(
    { state: "unhealthy" },
    enabled.length - healthy.length,
  );
  options.onHealthyAccounts?.(new Set(healthy.map((item) => item.accountId)));
  if (healthy.length === 0) return [];
  const desiredAids = await database.getDesiredWatchLaterSet(
    healthy.length * capacity,
  );
  const assignments = partitionDesiredWatchLaterAids(
    desiredAids,
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
      const result = await reconcileAccount(
        item.account,
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
      const canContinueAdding =
        phase === "add" &&
        (result.reason === "capacity_blocked" || result.reason === "ambiguous");
      if (result.reason !== "completed" && !canContinueAdding) {
        return results;
      }
    }
  }
  return results;
}
