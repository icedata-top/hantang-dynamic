import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// daily at UTC 22:00 (30 min after video_daily sync)
export async function initCronUserStats(pool: Pool, schema: string): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["update_user_stats"],
    );
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
  try {
    await pool.query(`
      SELECT cron.schedule(
        'update_user_stats',
        '0 22 * * *',
        $$
        SET search_path TO "${schema}";
        WITH stats AS (
          SELECT
            user_id,
            COUNT(*)   FILTER (WHERE NOT COALESCE(is_deleted, false))                    AS seen,
            COUNT(*)   FILTER (WHERE is_filtered AND NOT COALESCE(is_deleted, false))    AS filtered
          FROM "${schema}".processed_videos
          GROUP BY user_id
        )
        UPDATE "${schema}".discovered_users u
        SET
          videos_seen      = stats.seen,
          videos_filtered  = stats.filtered,
          filter_pass_rate = CASE WHEN stats.seen > 0
                             THEN stats.filtered::real / stats.seen
                             ELSE 0.0 END,
          last_updated     = now()
        FROM stats
        WHERE u.user_id = stats.user_id
        $$
      )
    `);
    logger.info("pg_cron: update_user_stats scheduled");
  } catch (err) {
    logger.debug("pg_cron: update_user_stats skipped", { err });
  }
}
