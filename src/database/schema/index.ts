import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";
import { initDynamicsSchema } from "./dynamics.js";
import { initFunctionsSchema } from "./functions.js";
import { initRecommendationsSchema } from "./recommendations.js";
import { initUserHistorySchema } from "./user_history.js";
import { initUsersSchema } from "./users.js";
import { initCronUserStats } from "./cron/user_stats.js";
import { initCronVideoDaily } from "./cron/video_daily.js";
import { initCronVideoDailyLatest } from "./cron/video_daily_latest.js";
import { initCronVideoMinute } from "./cron/video_minute.js";
import { initCronVideoStatic } from "./cron/video_static.js";
import { initVideoDailySchema } from "./video_daily.js";
import { initVideoDailyLatestSchema } from "./video_daily_latest.js";
import { initVideoHistorySchema } from "./video_history.js";
import { initVideoMinuteSchema } from "./video_minute.js";
import { initVideoStaticSchema } from "./video_static.js";
import { initVideosSchema } from "./videos.js";

export async function initializeSchema(pool: Pool, schema: string): Promise<void> {
  logger.info("Initializing database schema");

  await initFunctionsSchema(pool);
  await initVideosSchema(pool);
  await initDynamicsSchema(pool);
  await initRecommendationsSchema(pool);
  await initUsersSchema(pool);
  await initVideoHistorySchema(pool);
  await initUserHistorySchema(pool);
  await initVideoDailySchema(pool);
  await initVideoDailyLatestSchema(pool);
  await initVideoMinuteSchema(pool);
  await initVideoStaticSchema(pool);
  await initCronVideoDaily(pool, schema);
  await initCronVideoDailyLatest(pool, schema);
  await initCronVideoMinute(pool, schema);
  await initCronVideoStatic(pool, schema);
  await initCronUserStats(pool, schema);

  logger.info("Database schema initialized");
}
