import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// every hour at :00, UPSERT only when something changed
export async function initCronVideoStatic(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_static_from_mysql"],
    );
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_static_from_mysql',
        '0 * * * *',
        $$
        INSERT INTO video_static
          (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, priority, updated_at)
        SELECT
          aid, bvid, to_timestamp(pubdate), title, description, tag, pic, type_id, user_id, priority, now()
        FROM mysql_video_static m
        WHERE NOT EXISTS (
          SELECT 1 FROM video_static v
          WHERE v.aid      = m.aid
            AND v.bvid     = m.bvid
            AND v.title    = m.title
            AND v.priority IS NOT DISTINCT FROM m.priority
        )
        ON CONFLICT (aid) DO UPDATE SET
          bvid        = EXCLUDED.bvid,
          pubdate     = EXCLUDED.pubdate,
          title       = EXCLUDED.title,
          description = EXCLUDED.description,
          tag         = EXCLUDED.tag,
          pic         = EXCLUDED.pic,
          type_id     = EXCLUDED.type_id,
          user_id     = EXCLUDED.user_id,
          priority    = EXCLUDED.priority,
          updated_at  = now()
        $$
      )
    `);
    logger.info("pg_cron: sync_video_static_from_mysql scheduled");
  } catch {
    logger.debug("pg_cron: sync_video_static_from_mysql skipped (pg_cron not configured)");
  }
}
