import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type WatchLaterAction = "add" | "delete";

export interface WatchLaterAccount {
  accountId: bigint;
  lastCompleteSnapshotAt: Date | null;
}

export interface WatchLaterDesiredSet {
  aids: bigint[];
  mandatoryCount: number;
  overflow: boolean;
}

export interface WatchLaterAccountLease {
  renew(): Promise<boolean>;
}

interface WatchLaterAccountRow {
  account_id: string;
  last_complete_snapshot_at: Date | null;
}

function mapWatchLaterAccount(row: WatchLaterAccountRow): WatchLaterAccount {
  return {
    accountId: BigInt(row.account_id),
    lastCompleteSnapshotAt: row.last_complete_snapshot_at,
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
    `SELECT account_id, last_complete_snapshot_at
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

export async function withWatchLaterAccountLease<T>(
  pool: Pool,
  accountId: bigint,
  callback: (lease: WatchLaterAccountLease) => Promise<T>,
): Promise<T> {
  const leaseToken = randomUUID();
  const acquired = await pool.query(
    `UPDATE watch_later_account
     SET lease_token = $2::uuid,
         lease_expires_at = now() + interval '15 minutes',
         updated_at = now()
     WHERE account_id = $1
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING account_id`,
    [accountId.toString(), leaseToken],
  );
  if ((acquired.rowCount ?? 0) !== 1) {
    throw new Error(`Watch-later account ${accountId} is already leased`);
  }
  const lease: WatchLaterAccountLease = {
    async renew(): Promise<boolean> {
      const renewed = await pool.query(
        `UPDATE watch_later_account
         SET lease_expires_at = now() + interval '15 minutes',
             updated_at = now()
         WHERE account_id = $1
           AND lease_token = $2::uuid
           AND lease_expires_at > now()`,
        [accountId.toString(), leaseToken],
      );
      return (renewed.rowCount ?? 0) === 1;
    },
  };
  try {
    return await callback(lease);
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

export async function syncWatchLaterSnapshot(
  pool: Pool,
  accountId: bigint,
  observedAids: bigint[],
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

    const membershipResult = await client.query(
      `UPDATE video_collection_state
       SET watch_later_managed_account_ids = CASE
             WHEN aid = ANY($2::bigint[])
               AND NOT ($1::bigint = ANY(watch_later_managed_account_ids))
               THEN array_append(watch_later_managed_account_ids, $1::bigint)
             WHEN aid <> ALL($2::bigint[])
               THEN array_remove(watch_later_managed_account_ids, $1::bigint)
             ELSE watch_later_managed_account_ids
           END,
           updated_at = now()
       WHERE aid = ANY($2::bigint[])
          OR $1::bigint = ANY(watch_later_managed_account_ids)`,
      [accountId.toString(), observedAids.map((aid) => aid.toString())],
    );
    await client.query("COMMIT");
    return membershipResult.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
