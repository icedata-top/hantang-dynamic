import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// every hour at :15
export async function initCronVideoMinute(pool: Pool, schema: string): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_minute_from_mysql"],
    );
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
  try {
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_minute_from_mysql',
        '15 * * * *',
        $$
        SET search_path TO "${schema}";
        INSERT INTO "${schema}".video_minute
          ("time", aid, coin, favorite, danmaku, "view", reply, share, "like")
        SELECT
          to_timestamp("time"), aid, coin, favorite, danmaku, "view", reply, share, "like"
        FROM "${schema}".mysql_video_minute m
        WHERE to_timestamp(m."time") >= now() - INTERVAL '2 hours'
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}".video_minute v
            WHERE v.aid = m.aid AND v."time" = to_timestamp(m."time")
          )
        $$
      )
    `);
    logger.info("pg_cron: sync_video_minute_from_mysql scheduled");
  } catch (err) {
    logger.debug("pg_cron: sync_video_minute_from_mysql skipped", { err });
  }
}
