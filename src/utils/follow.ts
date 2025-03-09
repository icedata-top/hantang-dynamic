import { readFileSync, existsSync } from "fs";
import { parse } from "csv-parse/sync";
import {
  UserRelationAction,
  RelationSource,
  batchModifyUserRelation,
  fetchUserRelation,
} from "../api/relation";
import { sleep, retryDelay } from "./datetime";
import { logger } from "./logger";
import { config } from "../core/config";
import { join } from "path";

interface UserFollowData {
  user_id: number;
  video_count: number;
}

/**
 * Process batch following of users from a CSV file
 * @param csvPath Optional path to CSV file, defaults to /data/follow.csv
 * @param batchSize Number of users to process in each batch (default: 5)
 * @param waitTime Time to wait between batches in ms (default: 40000)
 */
export async function processFollows(
  csvPath?: string,
  batchSize = 50,
  waitTime = 40000
): Promise<void> {
  // Default path or use provided path
  const filePath = csvPath || join(process.cwd(), "data", "follow.csv");

  if (!existsSync(filePath)) {
    logger.error(`CSV file not found at ${filePath}`);
    return;
  }

  // Read CSV file
  logger.info(`Reading user follow data from ${filePath}`);
  const fileContent = readFileSync(filePath, "utf-8");
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    delimiter: '\t',
    cast: (value, context) => {
      if (context.column === "user_id" || context.column === "video_count") {
        return parseInt(value, 10);
      }
      return value;
    },
  }) as UserFollowData[];

  logger.info(`Found ${records.length} users in CSV file`);

  // Get current follows to avoid duplicates
  try {
    const currentFollows = await retryDelay(
      () => fetchUserRelation(config.BILIBILI_UID),
      config.API_RETRY_TIMES,
      config.API_WAIT_TIME
    );

    const currentFollowIds = new Set(
      currentFollows.attentions.map((id) => Number(id))
    );
    logger.info(`Currently following ${currentFollowIds.size} users`);

    // Filter out users that are already being followed
    const usersToFollow = records.filter(
      (record) => !currentFollowIds.has(record.user_id)
    );
    if (usersToFollow.length > 4999 - currentFollowIds.size) {
      logger.warn(
        `Exceeding the maximum number of users that can be followed: ${usersToFollow.length} > ${
          4999 - currentFollowIds.size
        }`
      );
      usersToFollow.splice(4999 - currentFollowIds.size);
    }
    logger.info(`Found ${usersToFollow.length} new users to follow`);

    // Process in batches
    for (let i = 0; i < usersToFollow.length; i += batchSize) {
      const batchUsers = usersToFollow.slice(i, i + batchSize);
      const userIds = batchUsers.map((u) => u.user_id);

      logger.info(
        `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(usersToFollow.length / batchSize)}`
      );
      logger.debug(`Following user IDs: ${userIds.join(", ")}`);

      try {
        const result = await batchModifyUserRelation(
          userIds,
          UserRelationAction.Follow,
          RelationSource.Profile,
          undefined,
          undefined
        );

        if (result.code === 0) {
          if (result.data.failed_fids.length === 0) {
            logger.info(`Successfully followed ${userIds.length} users`);
          } else {
            logger.warn(
              `Failed to follow ${result.data.failed_fids.length} users: ${result.data.failed_fids.join(", ")}`
            );
          }
        } else {
          logger.error(`API Error: ${result.code} - ${result.message}`);
        }
      } catch (error) {
        logger.error("Failed to follow users:", error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
      }

      if (i + batchSize < usersToFollow.length) {
        let waitTime_thistime = waitTime * (0.5 + Math.random());
        logger.info(
          `Waiting ${waitTime_thistime / 1000} seconds before next batch...`
        );
        await sleep(waitTime_thistime);
      }
    }

    logger.info("Follow process completed");
  } catch (error) {
    logger.error("Failed to process follows:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
  }
}
