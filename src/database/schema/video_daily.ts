import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoDailySchema(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE FOREIGN TABLE IF NOT EXISTS mysql_video_daily (
        record_date  date,
        aid          bigint,
        coin         integer,
        favorite     integer,
        danmaku      integer,
        "view"       integer,
        reply        integer,
        share        integer,
        "like"       integer
      )
      SERVER mysql_hantang_server
      OPTIONS (dbname 'hantang_dynamic', table_name 'video_daily')
    `);
    logger.debug("mysql_video_daily: foreign table ready");
  } catch {
    logger.debug("mysql_video_daily: skipped (mysql_fdw not configured)");
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_daily (
        record_date  date     NOT NULL,
        aid          bigint   NOT NULL,
        coin         integer,
        favorite     integer,
        danmaku      integer,
        "view"       integer,
        reply        integer,
        share        integer,
        "like"       integer
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_video_daily_aid_date
      ON video_daily(aid, record_date ASC)
    `);
    await pool.query(`
      SELECT create_hypertable(
        'video_daily',
        by_range('record_date', INTERVAL '90 days'),
        if_not_exists => TRUE,
        migrate_data  => TRUE
      )
    `);
    await pool.query(`
      ALTER TABLE video_daily SET (
        timescaledb.compress           = true,
        timescaledb.compress_segmentby = '',
        timescaledb.compress_orderby   = 'aid, record_date ASC'
      )
    `);
    await pool.query(`
      SELECT add_compression_policy(
        'video_daily',
        compress_after => INTERVAL '7 days',
        if_not_exists  => TRUE
      )
    `);
    logger.info("video_daily: schema ready");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`video_daily: schema setup skipped (${msg})`);
  }
}
