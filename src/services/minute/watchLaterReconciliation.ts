import { randomUUID } from "node:crypto";
import type {
  WatchLaterAccount,
  WatchLaterAction,
  WatchLaterOperation,
} from "../../database/watchLater";
import { sleep } from "../../utils/datetime";
import {
  fetchWatchLaterSnapshot,
  mutateWatchLater,
  type WatchLaterAccountContext,
  type WatchLaterSnapshot,
} from "./watchLaterApi";

export const WATCH_LATER_CAPACITY = 0;
const MAX_MUTATIONS_PER_RUN = 20;
const MUTATION_DELAY_MS = 1_000;
const POST_SETTLE_DELAY_MS = 3_000;
const CAPACITY_BLOCKED_CODE = 90001;
type Delay = (milliseconds: number) => Promise<void>;
type ProgressWriter = (text: string) => void;

export interface WatchLaterDatabase {
  getDesiredWatchLaterSet(targetCount: number): Promise<{
    aids: bigint[];
    overflow: boolean;
  }>;
  getWatchLaterOwnedAids(accountId: bigint): Promise<bigint[]>;
  getRecoverableWatchLaterOperations(
    accountId: bigint,
  ): Promise<WatchLaterOperation[]>;
  createWatchLaterOperation(input: {
    operationId: string;
    accountId: bigint;
    aid: bigint;
    action: WatchLaterAction;
    intentAt: Date;
    provenanceRunRef: string | null;
  }): Promise<void>;
  recordWatchLaterOperationAttempt(
    operationId: string,
    attemptedAt: Date,
  ): Promise<boolean>;
  resolveWatchLaterOperation(input: {
    operationId: string;
    resultClassification:
      | "succeeded"
      | "failed"
      | "ambiguous"
      | "capacity_blocked";
    resultCode: number | null;
    resolvedAt?: Date;
  }): Promise<boolean>;
  removeWatchLaterOwnershipAfterCompleteSnapshot(
    accountId: bigint,
    aids: bigint[],
    completedAt: Date,
  ): Promise<number>;
  recordWatchLaterCompleteSnapshot(
    accountId: bigint,
    completedAt: Date,
  ): Promise<void>;
  withWatchLaterAccountLease<T>(
    accountId: bigint,
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface WatchLaterReconciliationResult {
  reason: "snapshot_invalid" | "desired_overflow" | "completed";
  added: number;
  deleted: number;
  recovered: number;
  capacityBlocked: boolean;
}

export interface WatchLaterEmpiricalDatabase {
  getWatchLaterEligibleAids(maxPriorityExclusive: number): Promise<bigint[]>;
}

export interface WatchLaterEmpiricalResult {
  reason:
    | "eligible_exhausted"
    | "pre_snapshot_failed"
    | "request_failed"
    | "post_snapshot_failed"
    | "verification_failed";
  selected: number;
  added: number;
  preCount: number;
  postCount: number;
}

export function selectWatchLaterEmpiricalAccount<
  T extends { enableWatchLater?: boolean },
>(accounts: T[]): T {
  const enabledAccounts = accounts.filter(
    (account) => account.enableWatchLater,
  );
  if (enabledAccounts.length === 0) {
    throw new Error(
      "Empirical Watch Later run requires exactly one loaded account with enable_watch_later = true; found none.",
    );
  }
  if (enabledAccounts.length > 1) {
    throw new Error(
      "Empirical Watch Later run requires exactly one loaded account with enable_watch_later = true; found multiple.",
    );
  }
  return enabledAccounts[0];
}

function asAccountId(account: { uid: string }): bigint | null {
  if (!/^\d+$/.test(account.uid)) return null;
  return BigInt(account.uid);
}

function actionSucceeded(
  action: WatchLaterAction,
  aid: bigint,
  snapshot: WatchLaterSnapshot,
): boolean {
  return snapshot.aids.has(aid.toString()) === (action === "add");
}

async function recoverOperations(
  database: WatchLaterDatabase,
  accountId: bigint,
  snapshot: WatchLaterSnapshot,
): Promise<number> {
  const operations =
    await database.getRecoverableWatchLaterOperations(accountId);
  for (const operation of operations) {
    await database.resolveWatchLaterOperation({
      operationId: operation.operationId,
      resultClassification: actionSucceeded(
        operation.action,
        operation.aid,
        snapshot,
      )
        ? "succeeded"
        : "failed",
      resultCode: operation.resultCode,
      resolvedAt: snapshot.completedAt,
    });
  }
  return operations.length;
}

async function performOperation(
  database: WatchLaterDatabase,
  account: WatchLaterAccountContext,
  action: WatchLaterAction,
  aid: bigint,
  runRef: string,
): Promise<"succeeded" | "failed" | "ambiguous" | "capacity_blocked"> {
  const operationId = randomUUID();
  await database.createWatchLaterOperation({
    operationId,
    accountId: BigInt(account.uid),
    aid,
    action,
    intentAt: new Date(),
    provenanceRunRef: runRef,
  });

  await database.recordWatchLaterOperationAttempt(operationId, new Date());
  try {
    const code = await mutateWatchLater(account, aid, action);
    if (code === 0) {
      await database.resolveWatchLaterOperation({
        operationId,
        resultClassification: "succeeded",
        resultCode: code,
      });
      return "succeeded";
    }
    await database.resolveWatchLaterOperation({
      operationId,
      resultClassification:
        code === CAPACITY_BLOCKED_CODE ? "capacity_blocked" : "failed",
      resultCode: code,
    });
    return code === CAPACITY_BLOCKED_CODE ? "capacity_blocked" : "failed";
  } catch {
    await database.resolveWatchLaterOperation({
      operationId,
      resultClassification: "ambiguous",
      resultCode: null,
    });
    return "ambiguous";
  }
}

export async function reconcileWatchLaterAccount(
  database: WatchLaterDatabase,
  account: WatchLaterAccountContext,
  watchLaterAccount: WatchLaterAccount,
  delay: Delay = sleep,
  capacity: number = WATCH_LATER_CAPACITY,
): Promise<WatchLaterReconciliationResult> {
  return database.withWatchLaterAccountLease(
    watchLaterAccount.accountId,
    async () => {
      const snapshot = await fetchWatchLaterSnapshot(account.toViewClient);
      if (!snapshot)
        return {
          reason: "snapshot_invalid",
          added: 0,
          deleted: 0,
          recovered: 0,
          capacityBlocked: false,
        };

      const recovered = await recoverOperations(
        database,
        watchLaterAccount.accountId,
        snapshot,
      );
      if (capacity === 0) {
        await database.recordWatchLaterCompleteSnapshot(
          watchLaterAccount.accountId,
          snapshot.completedAt,
        );
        return {
          reason: "completed",
          added: 0,
          deleted: 0,
          recovered,
          capacityBlocked: false,
        };
      }

      const desired = await database.getDesiredWatchLaterSet(capacity);
      if (desired.overflow) {
        await database.recordWatchLaterCompleteSnapshot(
          watchLaterAccount.accountId,
          snapshot.completedAt,
        );
        return {
          reason: "desired_overflow",
          added: 0,
          deleted: 0,
          recovered,
          capacityBlocked: false,
        };
      }

      const owned = await database.getWatchLaterOwnedAids(
        watchLaterAccount.accountId,
      );
      const desiredIds = new Set(desired.aids.map((aid) => aid.toString()));
      const missingOwned = owned.filter(
        (aid) =>
          !snapshot.aids.has(aid.toString()) && !desiredIds.has(aid.toString()),
      );
      await database.removeWatchLaterOwnershipAfterCompleteSnapshot(
        watchLaterAccount.accountId,
        missingOwned,
        snapshot.completedAt,
      );

      let added = 0;
      let deleted = 0;
      let capacityBlocked = false;
      let requiresRecoverySnapshot = false;
      const runRef = randomUUID();
      const availableSlots = Math.max(0, capacity - snapshot.aids.size);
      const additions = desired.aids
        .filter((aid) => !snapshot.aids.has(aid.toString()))
        .slice(0, availableSlots);
      const deletions = owned.filter(
        (aid) =>
          snapshot.aids.has(aid.toString()) && !desiredIds.has(aid.toString()),
      );
      const operations: Array<{ action: WatchLaterAction; aid: bigint }> = [
        ...additions.map((aid) => ({ action: "add" as const, aid })),
        ...deletions.map((aid) => ({ action: "delete" as const, aid })),
      ].slice(0, MAX_MUTATIONS_PER_RUN);

      for (const operation of operations) {
        const outcome = await performOperation(
          database,
          account,
          operation.action,
          operation.aid,
          runRef,
        );
        if (outcome === "succeeded") {
          if (operation.action === "add") added += 1;
          else deleted += 1;
        }
        if (outcome === "capacity_blocked" || outcome === "ambiguous") {
          capacityBlocked = outcome === "capacity_blocked";
          requiresRecoverySnapshot = true;
          break;
        }
        if (
          outcome === "succeeded" &&
          operation !== operations[operations.length - 1]
        ) {
          await delay(MUTATION_DELAY_MS);
        }
      }

      if (!requiresRecoverySnapshot) {
        await database.recordWatchLaterCompleteSnapshot(
          watchLaterAccount.accountId,
          snapshot.completedAt,
        );
      }
      return {
        reason: "completed",
        added,
        deleted,
        recovered,
        capacityBlocked,
      };
    },
  );
}

export async function runAutomaticWatchLaterManagement(
  database: WatchLaterDatabase & {
    getWatchLaterAccounts(accountIds: bigint[]): Promise<WatchLaterAccount[]>;
  },
  accounts: WatchLaterAccountContext[],
  capacity: number = WATCH_LATER_CAPACITY,
): Promise<WatchLaterReconciliationResult[]> {
  const enabledAccounts = accounts.filter(
    (account) => account.enableWatchLater,
  );
  const accountsById = new Map(
    enabledAccounts.flatMap((account) => {
      const accountId = asAccountId(account);
      return accountId === null ? [] : [[accountId, account] as const];
    }),
  );
  const provisionedAccounts = await database.getWatchLaterAccounts([
    ...accountsById.keys(),
  ]);
  const results: WatchLaterReconciliationResult[] = [];
  for (const watchLaterAccount of provisionedAccounts) {
    const account = accountsById.get(watchLaterAccount.accountId);
    if (account) {
      results.push(
        await reconcileWatchLaterAccount(
          database,
          account,
          watchLaterAccount,
          sleep,
          capacity,
        ),
      );
    }
  }
  return results;
}

export async function runWatchLaterEmpiricalAddTest(
  database: WatchLaterEmpiricalDatabase,
  account: WatchLaterAccountContext,
  delay: Delay = sleep,
  writeProgress?: ProgressWriter,
  maxPriorityExclusive = 30,
): Promise<WatchLaterEmpiricalResult> {
  if (
    !Number.isInteger(maxPriorityExclusive) ||
    maxPriorityExclusive <= 1 ||
    maxPriorityExclusive > 721
  ) {
    throw new Error("Priority limit must be an integer from 2 through 721");
  }
  const initialSnapshot = await fetchWatchLaterSnapshot(account.toViewClient);
  if (!initialSnapshot) {
    return {
      reason: "pre_snapshot_failed",
      selected: 0,
      added: 0,
      preCount: 0,
      postCount: 0,
    };
  }

  let preSnapshot = initialSnapshot;
  const eligibleAids =
    await database.getWatchLaterEligibleAids(maxPriorityExclusive);
  const missingAids = eligibleAids.filter(
    (aid) => !initialSnapshot.aids.has(aid.toString()),
  );
  writeProgress?.(
    `priority<${maxPriorityExclusive} targets: ${eligibleAids.length}, present: ${eligibleAids.length - missingAids.length}, missing: ${missingAids.length}, watch-later total: ${initialSnapshot.aids.size}\n`,
  );
  let selectedTotal = 0;
  let addedTotal = 0;
  let delayBeforeNextMutation = false;
  let nextMissingIndex = 0;
  for (;;) {
    const selected = missingAids.slice(nextMissingIndex, nextMissingIndex + 10);
    selectedTotal += selected.length;
    if (selected.length === 0) {
      return {
        reason: "eligible_exhausted",
        selected: selectedTotal,
        added: addedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: preSnapshot.aids.size,
      };
    }

    writeProgress?.(
      `adding ${addedTotal + 1} to ${addedTotal + selected.length}: `,
    );
    for (const aid of selected) {
      if (delayBeforeNextMutation) await delay(MUTATION_DELAY_MS);
      try {
        if ((await mutateWatchLater(account, aid, "add")) !== 0) {
          writeProgress?.("\n");
          return {
            reason: "request_failed",
            selected: selectedTotal,
            added: addedTotal,
            preCount: initialSnapshot.aids.size,
            postCount: preSnapshot.aids.size,
          };
        }
      } catch {
        writeProgress?.("\n");
        return {
          reason: "request_failed",
          selected: selectedTotal,
          added: addedTotal,
          preCount: initialSnapshot.aids.size,
          postCount: preSnapshot.aids.size,
        };
      }
      addedTotal += 1;
      delayBeforeNextMutation = true;
      writeProgress?.(".");
    }
    writeProgress?.("\n");

    await delay(POST_SETTLE_DELAY_MS);
    delayBeforeNextMutation = false;
    const postSnapshot = await fetchWatchLaterSnapshot(account.toViewClient);
    if (!postSnapshot) {
      return {
        reason: "post_snapshot_failed",
        selected: selectedTotal,
        added: addedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: preSnapshot.aids.size,
      };
    }
    const verified =
      [...preSnapshot.aids].every((aid) => postSnapshot.aids.has(aid)) &&
      selected.every((aid) => postSnapshot.aids.has(aid.toString()));
    if (!verified) {
      return {
        reason: "verification_failed",
        selected: selectedTotal,
        added: addedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: postSnapshot.aids.size,
      };
    }
    preSnapshot = postSnapshot;
    nextMissingIndex += selected.length;
    if (selected.length < 10) {
      return {
        reason: "eligible_exhausted",
        selected: selectedTotal,
        added: addedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: postSnapshot.aids.size,
      };
    }
  }
}
