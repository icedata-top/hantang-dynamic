import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// every hour at :15
export async function initCronVideoMinute(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_minute_from_mysql"],
    );
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_minute_from_mysql',
        '15 * * * *',
        $$
        INSERT INTO video_minute
          ("time", aid, coin, favorite, danmaku, "view", reply, share, "like")
        SELECT
          to_timestamp("time"), aid, coin, favorite, danmaku, "view", reply, share, "like"
        FROM mysql_video_minute m
        WHERE to_timestamp(m."time") >= now() - INTERVAL '2 hours'
          AND NOT EXISTS (
            SELECT 1 FROM video_minute v
            WHERE v.aid = m.aid AND v."time" = to_timestamp(m."time")
          )
        $$
      )
    `);
    logger.info("pg_cron: sync_video_minute_from_mysql scheduled");
  } catch {
    logger.debug("pg_cron: sync_video_minute_from_mysql skipped (pg_cron not configured)");
  }
}
