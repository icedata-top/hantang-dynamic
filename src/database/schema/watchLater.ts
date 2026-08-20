import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";
import { initDueMinuteVideosFunction } from "./dueMinuteVideos.js";

/**
 * Create the watch-later state needed by periodic reconciliation.
 */
export async function initWatchLaterSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE video_collection_state
    ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids bigint[] NOT NULL DEFAULT '{}'
  `);

  await initDueMinuteVideosFunction(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_later_account (
      account_id bigint PRIMARY KEY,
      lease_token uuid,
      lease_expires_at timestamptz,
      last_complete_snapshot_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  logger.info("watch-later: schema ready");
}
