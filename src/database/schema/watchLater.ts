import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";
import { initDueMinuteVideosFunction } from "./dueMinuteVideos.js";

/** Create the collection state needed by Watch Later sampling. */
export async function initWatchLaterSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE video_collection_state
    ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids bigint[] NOT NULL DEFAULT '{}'
  `);

  await initDueMinuteVideosFunction(pool);
  logger.info("watch-later: schema ready");
}
