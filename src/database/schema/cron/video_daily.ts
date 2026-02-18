import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// every day at UTC 21:30 (Beijing 05:30)
export async function initCronVideoDaily(pool: Pool, schema: string): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_daily_from_mysql"],
    );
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
  try {
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_daily_from_mysql',
        '30 21 * * *',
        $$
        INSERT INTO "${schema}".video_daily
          (record_date, aid, coin, favorite, danmaku, "view", reply, share, "like")
        SELECT
          record_date, aid, coin, favorite, danmaku, "view", reply, share, "like"
        FROM "${schema}".mysql_video_daily m
        WHERE m.record_date >= CURRENT_DATE - INTERVAL '2 days'
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}".video_daily v
            WHERE v.aid = m.aid AND v.record_date = m.record_date
          )
        $$
      )
    `);
    logger.info("pg_cron: sync_video_daily_from_mysql scheduled");
  } catch (err) {
    logger.debug("pg_cron: sync_video_daily_from_mysql skipped", { err });
  }
}
