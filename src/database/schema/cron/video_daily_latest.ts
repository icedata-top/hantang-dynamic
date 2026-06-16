import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

// Disabled: video_daily_latest has no application-level readers.
// The table is kept for backward compatibility but the cron is unscheduled
// to avoid 570k UPSERT writes per day with no consumer.
export async function initCronVideoDailyLatest(
  pool: Pool,
  _schema: string,
): Promise<void> {
  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["update_video_daily_latest"],
    );
    logger.info("pg_cron: update_video_daily_latest unscheduled (no readers)");
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
}
