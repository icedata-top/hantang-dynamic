import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// daily at UTC 21:40 (10 min after video_daily sync)
export async function initCronVideoDailyLatest(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["update_video_daily_latest"],
    );
    await pool.query(`
      SELECT cron.schedule(
        'update_video_daily_latest',
        '40 21 * * *',
        $$
        INSERT INTO video_daily_latest
          (aid, record_date, coin, favorite, danmaku, "view", reply, share, "like", updated_at)
        SELECT DISTINCT ON (aid)
          aid, record_date, coin, favorite, danmaku, "view", reply, share, "like", now()
        FROM video_daily
        WHERE record_date >= CURRENT_DATE - INTERVAL '3 days'
        ORDER BY aid, record_date DESC
        ON CONFLICT (aid) DO UPDATE SET
          record_date = EXCLUDED.record_date,
          coin        = EXCLUDED.coin,
          favorite    = EXCLUDED.favorite,
          danmaku     = EXCLUDED.danmaku,
          "view"      = EXCLUDED."view",
          reply       = EXCLUDED.reply,
          share       = EXCLUDED.share,
          "like"      = EXCLUDED."like",
          updated_at  = now()
        $$
      )
    `);
    logger.info("pg_cron: update_video_daily_latest scheduled");
  } catch {
    logger.debug("pg_cron: update_video_daily_latest skipped (pg_cron not configured)");
  }
}
