import { randomUUID } from "node:crypto";
import type {
  WatchLaterAccount,
  WatchLaterAction,
  WatchLaterOperation,
} from "../../database/watchLater";
import { sleep } from "../../utils/datetime";
import { redactForLog } from "../../utils/redact";
import {
  fetchWatchLaterSnapshot,
  mutateWatchLater,
  type WatchLaterAccountContext,
  type WatchLaterSnapshot,
} from "./watchLaterApi";

export const WATCH_LATER_CAPACITY = 1_000;
const MAX_MUTATIONS_PER_RUN = 20;
const MUTATION_DELAY_MS = 1_000;
const POST_SETTLE_DELAY_MS = 3_000;
const CAPACITY_BLOCKED_CODE = 90001;
const MAX_CONSECUTIVE_EMPIRICAL_ADD_ERRORS = 20;
type Delay = (milliseconds: number) => Promise<void>;
type ProgressWriter = (text: string) => void;

interface ReconciliationInput {
  desiredAids?: bigint[];
  snapshot?: WatchLaterSnapshot;
}

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
  markWatchLaterEmpiricalFailedAid?(aid: bigint): Promise<boolean>;
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
  skipped: number;
  preCount: number;
  postCount: number;
  error?: string;
}

function describeWatchLaterRequestError(error: unknown): string {
  if (!error || typeof error !== "object") return "request failed";
  const record = error as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  const status = typeof record.status === "number" ? record.status : undefined;
  const biliCode =
    typeof data?.code === "number"
      ? data.code
      : status === undefined && typeof record.code === "number"
        ? record.code
        : undefined;
  const messageValue = data?.message ?? data?.msg ?? record.message;
  const message =
    typeof messageValue === "string"
      ? redactForLog(messageValue).replace(/\n/g, " ").slice(0, 300)
      : undefined;
  const parts = [
    status === undefined ? undefined : `HTTP ${status}`,
    biliCode === undefined ? undefined : `bili code ${biliCode}`,
    message,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "request failed";
}

function getWatchLaterRequestErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  if (typeof data?.code === "number") return data.code;
  return typeof record.code === "number" ? record.code : undefined;
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
  input: ReconciliationInput = {},
): Promise<WatchLaterReconciliationResult> {
  return database.withWatchLaterAccountLease(
    watchLaterAccount.accountId,
    async () => {
      const snapshot =
        input.snapshot ?? (await fetchWatchLaterSnapshot(account.toViewClient));
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

      const desired = input.desiredAids
        ? { aids: input.desiredAids, overflow: false }
        : await database.getDesiredWatchLaterSet(capacity);
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
      const additions = desired.aids.filter(
        (aid) => !snapshot.aids.has(aid.toString()),
      );
      const deletions = [...snapshot.aids]
        .map((aid) => BigInt(aid))
        .filter((aid) => !desiredIds.has(aid.toString()));
      let remainingMutations = MAX_MUTATIONS_PER_RUN;
      let availableSlots = Math.max(0, capacity - snapshot.aids.size);
      const operations = [
        ...deletions.map((aid) => ({ action: "delete" as const, aid })),
        ...additions.map((aid) => ({ action: "add" as const, aid })),
      ];

      for (const operation of operations) {
        if (remainingMutations === 0) break;
        if (operation.action === "add" && availableSlots === 0) continue;
        const outcome = await performOperation(
          database,
          account,
          operation.action,
          operation.aid,
          runRef,
        );
        if (outcome === "succeeded") {
          if (operation.action === "add") added += 1;
          else {
            deleted += 1;
            availableSlots += 1;
          }
        }
        remainingMutations -= 1;
        if (outcome === "capacity_blocked" || outcome === "ambiguous") {
          capacityBlocked = outcome === "capacity_blocked";
          requiresRecoverySnapshot = true;
          break;
        }
        if (outcome === "succeeded" && remainingMutations > 0) {
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
  const healthyAccounts: Array<{
    account: WatchLaterAccountContext;
    watchLaterAccount: WatchLaterAccount;
    snapshot: WatchLaterSnapshot;
  }> = [];
  for (const watchLaterAccount of provisionedAccounts) {
    const account = accountsById.get(watchLaterAccount.accountId);
    if (account) {
      const snapshot = await fetchWatchLaterSnapshot(account.toViewClient);
      if (snapshot) {
        healthyAccounts.push({ account, watchLaterAccount, snapshot });
      }
    }
  }
  if (healthyAccounts.length === 0) return [];

  const desired = await database.getDesiredWatchLaterSet(
    capacity * healthyAccounts.length,
  );
  const results: WatchLaterReconciliationResult[] = [];
  for (const [index, healthyAccount] of healthyAccounts.entries()) {
    const assignedAids = desired.aids.filter(
      (_aid, aidIndex) => aidIndex % healthyAccounts.length === index,
    );
    results.push(
      await reconcileWatchLaterAccount(
        database,
        healthyAccount.account,
        healthyAccount.watchLaterAccount,
        sleep,
        capacity,
        { desiredAids: assignedAids, snapshot: healthyAccount.snapshot },
      ),
    );
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
      skipped: 0,
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
  let skippedTotal = 0;
  let consecutiveAddErrors = 0;
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
        skipped: skippedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: preSnapshot.aids.size,
      };
    }

    writeProgress?.(
      `adding ${addedTotal + 1} to ${addedTotal + selected.length}: `,
    );
    const addedInBatch: bigint[] = [];
    for (const aid of selected) {
      if (delayBeforeNextMutation) await delay(MUTATION_DELAY_MS);
      let error: string | undefined;
      let errorCode: number | undefined;
      try {
        const code = await mutateWatchLater(account, aid, "add");
        if (code !== 0) {
          error = `bili code ${code}`;
          errorCode = code;
        }
      } catch (cause) {
        error = describeWatchLaterRequestError(cause);
        errorCode = getWatchLaterRequestErrorCode(cause);
      }
      if (error) {
        if (errorCode === CAPACITY_BLOCKED_CODE) {
          writeProgress?.(`request failed: ${error}\n`);
          return {
            reason: "request_failed",
            selected: selectedTotal,
            added: addedTotal,
            skipped: skippedTotal,
            preCount: initialSnapshot.aids.size,
            postCount: preSnapshot.aids.size,
            error,
          };
        }
        skippedTotal += 1;
        consecutiveAddErrors += 1;
        writeProgress?.(`x\nskipped add: ${error}\n`);
        const marked = await database.markWatchLaterEmpiricalFailedAid?.(aid);
        if (!marked) {
          const markingError = `failed to mark skipped aid after: ${error}`;
          writeProgress?.(`request failed: ${markingError}\n`);
          return {
            reason: "request_failed",
            selected: selectedTotal,
            added: addedTotal,
            skipped: skippedTotal,
            preCount: initialSnapshot.aids.size,
            postCount: preSnapshot.aids.size,
            error: markingError,
          };
        }
        if (consecutiveAddErrors === MAX_CONSECUTIVE_EMPIRICAL_ADD_ERRORS) {
          writeProgress?.(`request failed: ${error}\n`);
          return {
            reason: "request_failed",
            selected: selectedTotal,
            added: addedTotal,
            skipped: skippedTotal,
            preCount: initialSnapshot.aids.size,
            postCount: preSnapshot.aids.size,
            error,
          };
        }
        delayBeforeNextMutation = true;
        continue;
      }
      consecutiveAddErrors = 0;
      addedTotal += 1;
      addedInBatch.push(aid);
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
        skipped: skippedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: preSnapshot.aids.size,
      };
    }
    const verified =
      [...preSnapshot.aids].every((aid) => postSnapshot.aids.has(aid)) &&
      addedInBatch.every((aid) => postSnapshot.aids.has(aid.toString()));
    if (!verified) {
      return {
        reason: "verification_failed",
        selected: selectedTotal,
        added: addedTotal,
        skipped: skippedTotal,
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
        skipped: skippedTotal,
        preCount: initialSnapshot.aids.size,
        postCount: postSnapshot.aids.size,
      };
    }
  }
}
