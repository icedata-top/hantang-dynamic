import { Database } from "../database/index.js";
import { backfillMissionIds } from "../database/schema/videos.js";
import { logger } from "../utils/logger.js";

export async function runMissionIdBackfill(): Promise<void> {
  const db = Database.getInstance();
  logger.info("Starting processed-video mission backfill");

  try {
    await db.init();
    await backfillMissionIds(db.getPool());
    logger.info("Processed-video mission backfill complete");
  } finally {
    await db.close();
  }
}
