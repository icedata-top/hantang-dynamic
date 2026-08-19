import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type WatchLaterAction = "add" | "delete";

export type WatchLaterOperationResultClassification =
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "capacity_blocked";

export interface WatchLaterAccount {
  accountId: bigint;
  capacityBlockedAt: Date | null;
  lastCompleteSnapshotAt: Date | null;
}

export interface WatchLaterDesiredSet {
  aids: bigint[];
  mandatoryCount: number;
  overflow: boolean;
}

export interface WatchLaterOperationIntent {
  operationId: string;
  accountId: bigint;
  aid: bigint;
  action: WatchLaterAction;
  intentAt: Date;
  provenanceRunRef: string | null;
}

export interface WatchLaterOperation {
  operationId: string;
  accountId: bigint;
  aid: bigint;
  action: WatchLaterAction;
  intentAt: Date;
  requestAttemptCount: number;
  lastRequestAt: Date | null;
  resultClassification: "pending" | WatchLaterOperationResultClassification;
  resultCode: number | null;
  provenanceRunRef: string | null;
  resolvedAt: Date | null;
}

export interface WatchLaterOperationResolution {
  operationId: string;
  resultClassification: WatchLaterOperationResultClassification;
  resultCode: number | null;
  resolvedAt?: Date;
}

interface WatchLaterAccountRow {
  account_id: string;
  capacity_blocked_at: Date | null;
  last_complete_snapshot_at: Date | null;
}

interface WatchLaterOperationRow {
  operation_id: string;
  account_id: string;
  aid: string;
  action: WatchLaterAction;
  intent_at: Date;
  request_attempt_count: number;
  last_request_at: Date | null;
  result_classification: "pending" | WatchLaterOperationResultClassification;
  result_code: number | null;
  provenance_run_ref: string | null;
  resolved_at: Date | null;
}

function mapWatchLaterAccount(row: WatchLaterAccountRow): WatchLaterAccount {
  return {
    accountId: BigInt(row.account_id),
    capacityBlockedAt: row.capacity_blocked_at,
    lastCompleteSnapshotAt: row.last_complete_snapshot_at,
  };
}

function mapWatchLaterOperation(
  row: WatchLaterOperationRow,
): WatchLaterOperation {
  return {
    operationId: row.operation_id,
    accountId: BigInt(row.account_id),
    aid: BigInt(row.aid),
    action: row.action,
    intentAt: row.intent_at,
    requestAttemptCount: row.request_attempt_count,
    lastRequestAt: row.last_request_at,
    resultClassification: row.result_classification,
    resultCode: row.result_code,
    provenanceRunRef: row.provenance_run_ref,
    resolvedAt: row.resolved_at,
  };
}

export async function provisionWatchLaterAccounts(
  pool: Pool,
  accountIds: bigint[],
): Promise<void> {
  for (const accountId of accountIds) {
    await pool.query(
      `INSERT INTO watch_later_account (account_id)
       VALUES ($1)
       ON CONFLICT (account_id) DO UPDATE
       SET updated_at = now()`,
      [accountId.toString()],
    );
  }
}

export async function getWatchLaterAccounts(
  pool: Pool,
  accountIds: bigint[],
): Promise<WatchLaterAccount[]> {
  const result = await pool.query<WatchLaterAccountRow>(
    `SELECT account_id, capacity_blocked_at,
            last_complete_snapshot_at
     FROM watch_later_account
     WHERE account_id = ANY($1::bigint[])
     ORDER BY account_id ASC`,
    [accountIds.map((accountId) => accountId.toString())],
  );

  return result.rows.map(mapWatchLaterAccount);
}

export async function getDesiredWatchLaterSet(
  pool: Pool,
  targetCount: number,
): Promise<WatchLaterDesiredSet> {
  const result = await pool.query<{ aid: string }>(
    `WITH priority_candidates AS (
       SELECT aid, priority
       FROM video_collection_state
       WHERE priority > 0
         AND NOT (-1 = ANY(watch_later_managed_account_ids))
       ORDER BY priority ASC, aid ASC
       LIMIT ($1 * 3 / 5)
     ),
     rolling_candidates AS (
       SELECT state.aid
       FROM video_collection_state AS state
       INNER JOIN processed_videos AS video ON video.aid = state.aid
       WHERE state.priority >= 0
         AND video.is_filtered = TRUE
         AND COALESCE(video.is_deleted, FALSE) = FALSE
         AND NOT (-1 = ANY(state.watch_later_managed_account_ids))
         AND NOT EXISTS (
           SELECT 1
           FROM priority_candidates
           WHERE priority_candidates.aid = state.aid
         )
       ORDER BY video.pubdate DESC NULLS LAST, video.aid DESC
       LIMIT LEAST(
         GREATEST($1 - (SELECT count(*) FROM priority_candidates), 0),
         ($1 * 2 / 5)
       )
     )
     SELECT aid, 0 AS section, priority AS priority_order,
            aid AS priority_aid_order, NULL::bigint AS pubdate_order,
            NULL::bigint AS rolling_aid_order
     FROM priority_candidates
     UNION ALL
     SELECT rolling_candidates.aid, 1 AS section, 0 AS priority_order,
            NULL::bigint AS priority_aid_order, video.pubdate AS pubdate_order,
            video.aid AS rolling_aid_order
     FROM rolling_candidates
     INNER JOIN processed_videos AS video ON video.aid = rolling_candidates.aid
     ORDER BY section ASC, priority_order ASC, priority_aid_order ASC NULLS LAST,
              pubdate_order DESC NULLS LAST, rolling_aid_order DESC NULLS LAST`,
    [targetCount],
  );

  return {
    aids: result.rows.map((row) => BigInt(row.aid)),
    mandatoryCount: result.rows.length,
    overflow: false,
  };
}

export async function getWatchLaterEligibleAids(
  pool: Pool,
  maxPriorityExclusive: number,
): Promise<bigint[]> {
  const result = await pool.query<{ aid: string }>(
    `SELECT aid
     FROM video_collection_state
     WHERE priority >= 1
       AND priority < $1
       AND NOT (-1 = ANY(watch_later_managed_account_ids))
     ORDER BY priority ASC, aid ASC`,
    [maxPriorityExclusive],
  );

  return result.rows.map((row) => BigInt(row.aid));
}

export async function markWatchLaterEmpiricalFailedAid(
  pool: Pool,
  aid: bigint,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE video_collection_state
     SET watch_later_managed_account_ids = CASE
       WHEN -1 = ANY(watch_later_managed_account_ids)
         THEN watch_later_managed_account_ids
       ELSE array_append(watch_later_managed_account_ids, -1)
     END
     WHERE aid = $1::bigint`,
    [aid.toString()],
  );
  return result.rowCount === 1;
}

export async function getWatchLaterOwnedAids(
  pool: Pool,
  accountId: bigint,
): Promise<bigint[]> {
  const result = await pool.query<{ aid: string }>(
    `SELECT aid
     FROM video_collection_state
     WHERE $1::bigint = ANY(watch_later_managed_account_ids)
     ORDER BY aid ASC`,
    [accountId.toString()],
  );

  return result.rows.map((row) => BigInt(row.aid));
}

export async function createWatchLaterOperation(
  pool: Pool,
  input: WatchLaterOperationIntent,
): Promise<void> {
  await pool.query(
    `INSERT INTO watch_later_account_operation (
       operation_id, account_id, aid, action, intent_at, provenance_run_ref
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (operation_id) DO NOTHING`,
    [
      input.operationId,
      input.accountId.toString(),
      input.aid.toString(),
      input.action,
      input.intentAt,
      input.provenanceRunRef,
    ],
  );
}

export async function recordWatchLaterOperationAttempt(
  pool: Pool,
  operationId: string,
  attemptedAt: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE watch_later_account_operation
     SET request_attempt_count = request_attempt_count + 1,
         last_request_at = $2,
         updated_at = now()
     WHERE operation_id = $1
       AND result_classification = 'pending'`,
    [operationId, attemptedAt],
  );

  return (result.rowCount ?? 0) === 1;
}

export async function getRecoverableWatchLaterOperations(
  pool: Pool,
  accountId: bigint,
): Promise<WatchLaterOperation[]> {
  const result = await pool.query<WatchLaterOperationRow>(
    `SELECT operation_id, account_id, aid, action, intent_at,
            request_attempt_count, last_request_at, result_classification,
            result_code, provenance_run_ref, resolved_at
     FROM watch_later_account_operation
     WHERE account_id = $1
       AND result_classification IN ('pending', 'ambiguous')
     ORDER BY intent_at ASC, operation_id ASC`,
    [accountId.toString()],
  );

  return result.rows.map(mapWatchLaterOperation);
}

export async function resolveWatchLaterOperation(
  pool: Pool,
  input: WatchLaterOperationResolution,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const operationResult = await client.query<WatchLaterOperationRow>(
      `SELECT operation_id, account_id, aid, action, intent_at,
              request_attempt_count, last_request_at, result_classification,
              result_code, provenance_run_ref, resolved_at
       FROM watch_later_account_operation
       WHERE operation_id = $1
       FOR UPDATE`,
      [input.operationId],
    );
    const operation = operationResult.rows[0];
    if (!operation) {
      throw new Error(
        `Watch-later operation ${input.operationId} does not exist`,
      );
    }
    if (
      operation.result_classification !== "pending" &&
      operation.result_classification !== "ambiguous"
    ) {
      await client.query("COMMIT");
      return false;
    }

    const resolvedAt =
      input.resultClassification === "ambiguous"
        ? null
        : (input.resolvedAt ?? new Date());
    await client.query(
      `UPDATE watch_later_account_operation
       SET result_classification = $2,
           result_code = $3,
           resolved_at = $4,
           updated_at = now()
       WHERE operation_id = $1`,
      [
        input.operationId,
        input.resultClassification,
        input.resultCode,
        resolvedAt,
      ],
    );

    if (input.resultClassification === "succeeded") {
      const ownershipResult = await client.query(
        `UPDATE video_collection_state
         SET watch_later_managed_account_ids = CASE
               WHEN $3 = 'add'
                    AND NOT ($2::bigint = ANY(watch_later_managed_account_ids))
                THEN array_append(watch_later_managed_account_ids, $2::bigint)
               WHEN $3 = 'delete'
                 THEN array_remove(watch_later_managed_account_ids, $2::bigint)
               ELSE watch_later_managed_account_ids
             END,
             updated_at = now()
         WHERE aid = $1`,
        [operation.aid, operation.account_id, operation.action],
      );
      if (operation.action === "add" && (ownershipResult.rowCount ?? 0) !== 1) {
        throw new Error(
          `Video collection state for watch-later operation ${input.operationId} does not exist`,
        );
      }
    }

    if (input.resultClassification === "capacity_blocked") {
      await client.query(
        `UPDATE watch_later_account
         SET capacity_blocked_at = $2,
             updated_at = now()
         WHERE account_id = $1`,
        [operation.account_id, resolvedAt],
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withWatchLaterAccountLease<T>(
  pool: Pool,
  accountId: bigint,
  callback: () => Promise<T>,
): Promise<T> {
  const leaseToken = randomUUID();
  const acquired = await pool.query(
    `UPDATE watch_later_account
     SET lease_token = $2::uuid,
         lease_expires_at = now() + interval '5 minutes',
         updated_at = now()
     WHERE account_id = $1
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING account_id`,
    [accountId.toString(), leaseToken],
  );
  if ((acquired.rowCount ?? 0) !== 1) {
    throw new Error(`Watch-later account ${accountId} is already leased`);
  }
  try {
    return await callback();
  } finally {
    await pool.query(
      `UPDATE watch_later_account
       SET lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE account_id = $1
         AND lease_token = $2::uuid`,
      [accountId.toString(), leaseToken],
    );
  }
}

export async function recordWatchLaterCompleteSnapshot(
  pool: Pool,
  accountId: bigint,
  completedAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE watch_later_account
     SET last_complete_snapshot_at = $2,
         updated_at = now()
     WHERE account_id = $1`,
    [accountId.toString(), completedAt],
  );
}

export async function removeWatchLaterOwnershipAfterCompleteSnapshot(
  pool: Pool,
  accountId: bigint,
  aids: bigint[],
  completedAt: Date,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query(
      `UPDATE watch_later_account
       SET last_complete_snapshot_at = $2,
           updated_at = now()
       WHERE account_id = $1`,
      [accountId.toString(), completedAt],
    );
    if ((accountResult.rowCount ?? 0) !== 1) {
      throw new Error(`Watch-later account ${accountId} does not exist`);
    }

    if (aids.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const ownershipResult = await client.query(
      `UPDATE video_collection_state
       SET watch_later_managed_account_ids = array_remove(
             watch_later_managed_account_ids,
             $1::bigint
           ),
           updated_at = now()
       WHERE aid = ANY($2::bigint[])
         AND $1::bigint = ANY(watch_later_managed_account_ids)`,
      [accountId.toString(), aids.map((aid) => aid.toString())],
    );
    await client.query("COMMIT");
    return ownershipResult.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
