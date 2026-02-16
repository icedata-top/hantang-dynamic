import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoMinuteSchema(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE FOREIGN TABLE IF NOT EXISTS mysql_video_minute (
        "time"     bigint,
        aid        bigint,
        bvid       varchar(255),
        coin       integer,
        favorite   integer,
        danmaku    integer,
        "view"     integer,
        reply      integer,
        share      integer,
        "like"     integer
      )
      SERVER mysql_hantang_server
      OPTIONS (dbname 'hantang_dynamic', table_name 'video_minute')
    `);
    logger.debug("mysql_video_minute: foreign table ready");
  } catch {
    logger.debug("mysql_video_minute: skipped (mysql_fdw not configured)");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_minute (
      "time"    timestamptz  NOT NULL,
      aid       bigint       NOT NULL,
      coin      integer,
      favorite  integer,
      danmaku   integer,
      "view"    integer,
      reply     integer,
      share     integer,
      "like"    integer
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_minute_aid_time
    ON video_minute(aid, "time" ASC)
  `);

  try {
    await pool.query(`
      SELECT create_hypertable(
        'video_minute',
        by_range('time', INTERVAL '90 days'),
        if_not_exists => TRUE,
        migrate_data  => TRUE
      )
    `);
    await pool.query(`
      ALTER TABLE video_minute SET (
        timescaledb.compress           = true,
        timescaledb.compress_segmentby = '',
        timescaledb.compress_orderby   = 'aid, "time" ASC'
      )
    `);
    await pool.query(`
      SELECT add_compression_policy(
        'video_minute',
        compress_after => INTERVAL '7 days',
        if_not_exists  => TRUE
      )
    `);
    logger.info("video_minute: TimescaleDB hypertable enabled");
  } catch {
    logger.debug("video_minute: TimescaleDB not available, using plain table");
  }
}
