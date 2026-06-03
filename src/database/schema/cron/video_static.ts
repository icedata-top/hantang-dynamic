import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// every hour at :00, UPSERT only when something changed
export async function initCronVideoStatic(
  pool: Pool,
  schema: string,
): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_static_from_mysql"],
    );
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
  try {
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_static_from_mysql',
        '0 * * * *',
        $$
        SET search_path TO "${schema}";
        WITH changed AS (
          SELECT m.*
          FROM "${schema}".mysql_video_static m
          WHERE NOT EXISTS (
            SELECT 1 FROM "${schema}".video_static v
            WHERE v.aid      = m.aid
              AND v.title    = m.title
              AND v.priority IS NOT DISTINCT FROM m.priority
          )
        )
        INSERT INTO "${schema}".video_static
          (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, priority, updated_at)
        SELECT
          aid, av2bv(aid), to_timestamp(pubdate), title, description, tag, pic, type_id, user_id, priority, now()
        FROM changed
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
  } catch (err) {
    logger.debug("pg_cron: sync_video_static_from_mysql skipped", { err });
  }
}
