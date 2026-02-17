import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoDailyLatestSchema(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_daily_latest (
        aid          bigint   PRIMARY KEY,
        record_date  date     NOT NULL,
        coin         integer,
        favorite     integer,
        danmaku      integer,
        "view"       integer,
        reply        integer,
        share        integer,
        "like"       integer,
        updated_at   timestamp with time zone DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_video_daily_latest_record_date
      ON video_daily_latest(record_date DESC)
    `);
    logger.info("video_daily_latest: schema ready");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`video_daily_latest: schema setup failed (${msg})`);
  }
}
