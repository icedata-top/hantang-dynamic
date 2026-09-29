import type { Pool } from "pg";
import { updateProcessedVideoPidV2 } from "./videos.js";

export type WatchLaterAction = "add" | "delete";

export async function getDesiredWatchLaterSet(
  pool: Pool,
  targetCount: number,
): Promise<bigint[]> {
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
       LIMIT ($1 * 2 / 5)
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

  return result.rows.map((row) => BigInt(row.aid));
}

export async function syncWatchLaterSnapshot(
  pool: Pool,
  accountId: bigint,
  observedAids: bigint[],
  pidV2Metadata: ReadonlyArray<{ aid: bigint; pidV2: number }>,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await updateProcessedVideoPidV2(client, pidV2Metadata);

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
