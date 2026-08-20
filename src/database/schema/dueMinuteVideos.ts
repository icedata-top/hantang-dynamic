import type { Pool } from "pg";

/**
 * Replace the due-video function after its Watch Later return column exists.
 */
export async function initDueMinuteVideosFunction(pool: Pool): Promise<void> {
  await pool.query(`
    DROP FUNCTION IF EXISTS fn_select_due_minute_videos(timestamptz, integer)
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_select_due_minute_videos(
      p_now timestamptz DEFAULT now(),
      p_limit integer DEFAULT 50
    ) RETURNS TABLE (aid bigint, last_view bigint, near_gate boolean, due_at timestamptz, watch_later_managed_account_ids bigint[]) AS $$
    BEGIN
      -- Expire bootstrap entries that never got daily data
      UPDATE video_collection_state
      SET priority = 0,
          next_minute_due_at = NULL,
          updated_at = p_now
      WHERE priority > 0
        AND daily_delta_source = 'bootstrap'
        AND bootstrap_until IS NOT NULL
        AND bootstrap_until <= p_now
        AND latest_daily_delta IS NULL
        AND weekly_avg_daily_delta IS NULL;

      RETURN QUERY
      SELECT s.aid, s.last_view,
        (s.last_minute_success_at IS NOT NULL
          AND extract(epoch from s.next_minute_due_at - s.last_minute_success_at)
              BETWEEN 0 AND 74
        ) AS near_gate,
        s.next_minute_due_at AS due_at,
        s.watch_later_managed_account_ids
      FROM video_collection_state s
      WHERE s.priority > 0
        AND s.next_minute_due_at IS NOT NULL
        AND s.next_minute_due_at <= p_now
      ORDER BY s.next_minute_due_at ASC, s.aid ASC
      LIMIT p_limit;
    END;
    $$ LANGUAGE plpgsql
  `);
}
