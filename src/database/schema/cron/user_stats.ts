import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// daily at UTC 22:00 (30 min after video_daily sync)
export async function initCronUserStats(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["update_user_stats"],
    );
    await pool.query(`
      SELECT cron.schedule(
        'update_user_stats',
        '0 22 * * *',
        $$
        UPDATE discovered_users u
        SET
          videos_seen      = stats.seen,
          videos_filtered  = stats.filtered,
          filter_pass_rate = CASE WHEN stats.seen > 0
                             THEN stats.filtered::real / stats.seen
                             ELSE 0.0 END,
          filtered_view    = stats.filtered_view,
          last_updated     = now()
        FROM (
          SELECT
            pv.user_id,
            COUNT(*)             FILTER (WHERE NOT COALESCE(pv.is_deleted, false))                              AS seen,
            COUNT(*)             FILTER (WHERE pv.is_filtered AND NOT COALESCE(pv.is_deleted, false))          AS filtered,
            COALESCE(SUM(latest."view") FILTER (WHERE pv.is_filtered AND NOT COALESCE(pv.is_deleted, false)), 0) AS filtered_view
          FROM processed_videos pv
          LEFT JOIN LATERAL (
            SELECT "view"
            FROM video_daily
            WHERE aid = pv.aid
            ORDER BY record_date DESC
            LIMIT 1
          ) latest ON true
          GROUP BY pv.user_id
        ) stats
        WHERE u.user_id = stats.user_id
        $$
      )
    `);
    logger.info("pg_cron: update_user_stats scheduled");
  } catch {
    logger.debug("pg_cron: update_user_stats skipped (pg_cron not configured)");
  }
}
