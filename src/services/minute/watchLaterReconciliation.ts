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

export const WATCH_LATER_AUTOMATIC_CAPACITY = 0;
const MAX_MUTATIONS_PER_RUN = 20;
const MUTATION_DELAY_MS = 1_000;
const MAX_MUTATION_ATTEMPTS = 2;
const CAPACITY_BLOCKED_CODE = 90001;

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
  getWatchLaterEligibleAids(
    excludedAids: bigint[],
    limit: number,
  ): Promise<bigint[]>;
}

export interface WatchLaterEmpiricalResult {
  reason:
    | "completed"
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

  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
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
      if (code === CAPACITY_BLOCKED_CODE) {
        await database.resolveWatchLaterOperation({
          operationId,
          resultClassification: "capacity_blocked",
          resultCode: code,
        });
        return "capacity_blocked";
      }
      if (attempt + 1 === MAX_MUTATION_ATTEMPTS) {
        await database.resolveWatchLaterOperation({
          operationId,
          resultClassification: "failed",
          resultCode: code,
        });
        return "failed";
      }
      await sleep(MUTATION_DELAY_MS * (attempt + 1));
    } catch {
      await database.resolveWatchLaterOperation({
        operationId,
        resultClassification: "ambiguous",
        resultCode: null,
      });
      return "ambiguous";
    }
  }
  return "failed";
}

export async function reconcileWatchLaterAccount(
  database: WatchLaterDatabase,
  account: WatchLaterAccountContext,
  configured: WatchLaterAccount,
  capacity: number,
): Promise<WatchLaterReconciliationResult> {
  return database.withWatchLaterAccountLease(configured.accountId, async () => {
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
      configured.accountId,
      snapshot,
    );
    const accountCapacity = Math.min(
      configured.remoteCapacity ?? capacity,
      capacity,
    );
    const targetCount = Math.min(configured.targetCount, accountCapacity);
    const desired = await database.getDesiredWatchLaterSet(targetCount);
    if (desired.overflow) {
      await database.recordWatchLaterCompleteSnapshot(
        configured.accountId,
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

    const owned = await database.getWatchLaterOwnedAids(configured.accountId);
    const desiredIds = new Set(desired.aids.map((aid) => aid.toString()));
    const missingOwned = owned.filter(
      (aid) =>
        !snapshot.aids.has(aid.toString()) && !desiredIds.has(aid.toString()),
    );
    await database.removeWatchLaterOwnershipAfterCompleteSnapshot(
      configured.accountId,
      missingOwned,
      snapshot.completedAt,
    );

    let added = 0;
    let deleted = 0;
    let capacityBlocked = false;
    let requiresRecoverySnapshot = false;
    const runRef = randomUUID();
    const availableSlots = Math.max(0, accountCapacity - snapshot.aids.size);
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
      await sleep(MUTATION_DELAY_MS);
    }

    if (!requiresRecoverySnapshot) {
      await database.recordWatchLaterCompleteSnapshot(
        configured.accountId,
        snapshot.completedAt,
      );
    }
    return { reason: "completed", added, deleted, recovered, capacityBlocked };
  });
}

export async function runAutomaticWatchLaterManagement(
  database: WatchLaterDatabase & {
    getEnabledWatchLaterAccounts(): Promise<WatchLaterAccount[]>;
  },
  accounts: WatchLaterAccountContext[],
): Promise<WatchLaterReconciliationResult[]> {
  if (WATCH_LATER_AUTOMATIC_CAPACITY === 0) {
    return [];
  }
  const accountsById = new Map(
    accounts.flatMap((account) => {
      const accountId = asAccountId(account);
      return accountId === null ? [] : [[accountId, account] as const];
    }),
  );
  const configuredAccounts = await database.getEnabledWatchLaterAccounts();
  const results: WatchLaterReconciliationResult[] = [];
  for (const configured of configuredAccounts) {
    const account = accountsById.get(configured.accountId);
    if (account) {
      results.push(
        await reconcileWatchLaterAccount(
          database,
          account,
          configured,
          WATCH_LATER_AUTOMATIC_CAPACITY,
        ),
      );
    }
  }
  return results;
}

export async function runWatchLaterEmpiricalAddTest(
  database: WatchLaterEmpiricalDatabase,
  account: WatchLaterAccountContext,
): Promise<WatchLaterEmpiricalResult> {
  const preSnapshot = await fetchWatchLaterSnapshot(account.toViewClient);
  if (!preSnapshot) {
    return {
      reason: "pre_snapshot_failed",
      selected: 0,
      added: 0,
      preCount: 0,
      postCount: 0,
    };
  }

  const selected = await database.getWatchLaterEligibleAids(
    [...preSnapshot.aids].map((aid) => BigInt(aid)),
    10,
  );
  let added = 0;
  for (const aid of selected) {
    try {
      if ((await mutateWatchLater(account, aid, "add")) !== 0) {
        return {
          reason: "request_failed",
          selected: selected.length,
          added,
          preCount: preSnapshot.aids.size,
          postCount: 0,
        };
      }
      added += 1;
    } catch {
      return {
        reason: "request_failed",
        selected: selected.length,
        added,
        preCount: preSnapshot.aids.size,
        postCount: 0,
      };
    }
  }

  const postSnapshot = await fetchWatchLaterSnapshot(account.toViewClient);
  if (!postSnapshot) {
    return {
      reason: "post_snapshot_failed",
      selected: selected.length,
      added,
      preCount: preSnapshot.aids.size,
      postCount: 0,
    };
  }
  const verified =
    [...preSnapshot.aids].every((aid) => postSnapshot.aids.has(aid)) &&
    selected.every((aid) => postSnapshot.aids.has(aid.toString()));
  if (!verified) {
    return {
      reason: "verification_failed",
      selected: selected.length,
      added,
      preCount: preSnapshot.aids.size,
      postCount: postSnapshot.aids.size,
    };
  }
  return {
    reason: selected.length < 10 ? "eligible_exhausted" : "completed",
    selected: selected.length,
    added,
    preCount: preSnapshot.aids.size,
    postCount: postSnapshot.aids.size,
  };
}
