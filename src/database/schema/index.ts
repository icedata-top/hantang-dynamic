import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";
import { initCollectionQueueSchema } from "./collection_queue.js";
import { initCollectionStateSchema } from "./collection_state.js";
import { initCronUserStats } from "./cron/user_stats.js";
import { initCronVideoDaily } from "./cron/video_daily.js";
import { initCronVideoDailyLatest } from "./cron/video_daily_latest.js";
import { initCronVideoStatic } from "./cron/video_static.js";
import { initDynamicsSchema } from "./dynamics.js";
import { initFunctionsSchema } from "./functions.js";
import { initRecommendationsSchema } from "./recommendations.js";
import { initUserHistorySchema } from "./user_history.js";
import { initUsersSchema } from "./users.js";
import { initVideoDailySchema } from "./video_daily.js";
import { initVideoDailyLatestSchema } from "./video_daily_latest.js";
import { initVideoHistorySchema } from "./video_history.js";
import { initVideoMinuteSchema } from "./video_minute.js";
import { initVideoStaticSchema } from "./video_static.js";
import { initVideoSubtitlesSchema } from "./video_subtitles.js";
import { initVideosSchema } from "./videos.js";

export async function initializeSchema(
  pool: Pool,
  schema: string,
): Promise<void> {
  logger.info("Initializing database schema");

  await initFunctionsSchema(pool);

  await Promise.all([
    initVideosSchema(pool),
    initDynamicsSchema(pool),
    initUsersSchema(pool),
    initVideoDailySchema(pool),
    initVideoDailyLatestSchema(pool),
    initVideoMinuteSchema(pool),
    initVideoStaticSchema(pool),
  ]);

  await Promise.all([
    initRecommendationsSchema(pool),
    initVideoHistorySchema(pool),
    initUserHistorySchema(pool),
    initCollectionStateSchema(pool),
  ]);

  await Promise.all([
    initCollectionQueueSchema(pool),
    initCronVideoDaily(pool, schema),
    initCronVideoDailyLatest(pool, schema),
    initCronVideoStatic(pool, schema),
    initCronUserStats(pool, schema),
  ]);

  await initVideoSubtitlesSchema(pool);

  logger.info("Database schema initialized");
}
