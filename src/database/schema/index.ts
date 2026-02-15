import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";
import { initForwardsSchema } from "./forwards.js";
import { initFunctionsSchema } from "./functions.js";
import { initRecommendationsSchema } from "./recommendations.js";
import { initUserHistorySchema } from "./user_history.js";
import { initUsersSchema } from "./users.js";
import { initVideoHistorySchema } from "./video_history.js";
import { initVideosSchema } from "./videos.js";

export async function initializeSchema(pool: Pool): Promise<void> {
  logger.info("Initializing database schema");

  await initFunctionsSchema(pool);
  await initVideosSchema(pool);
  await initForwardsSchema(pool);
  await initRecommendationsSchema(pool);
  await initUsersSchema(pool);
  await initVideoHistorySchema(pool);
  await initUserHistorySchema(pool);

  logger.info("Database schema initialized");
}
