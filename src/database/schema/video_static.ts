import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoStaticSchema(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE FOREIGN TABLE IF NOT EXISTS mysql_video_static (
        aid         bigint       NOT NULL,
        bvid        varchar(50)  NOT NULL,
        pubdate     integer      NOT NULL,
        title       varchar(255) NOT NULL,
        description text,
        tag         text,
        pic         varchar(255),
        type_id     integer,
        user_id     bigint,
        priority    integer
      )
      SERVER mysql_hantang_server
      OPTIONS (dbname 'hantang_dynamic', table_name 'video_static')
    `);
    logger.debug("mysql_video_static: foreign table ready");
  } catch {
    logger.debug("mysql_video_static: skipped (mysql_fdw not configured)");
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_static (
        aid         bigint       PRIMARY KEY,
        bvid        varchar(50)  NOT NULL,
        pubdate     timestamptz  NOT NULL,
        title       varchar(255) NOT NULL,
        description text,
        tag         text,
        pic         varchar(255),
        type_id     integer,
        user_id     bigint,
        priority    integer,
        updated_at  timestamptz  DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_static_bvid ON video_static(bvid)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_static_user ON video_static(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_static_type ON video_static(type_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_static_pub  ON video_static(pubdate)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_static_prio ON video_static(priority)`);
    logger.info("video_static: schema ready");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`video_static: schema setup skipped (${msg})`);
  }
}
