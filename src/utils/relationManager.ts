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
 * @param batchSize Number of users to process in each batch (default: 50)
 * @param waitTime Time to wait between batches in ms (default: 40000)
 * @param follow Toggle for follow or block (default: true(follow))
 */
export async function processFollows(
  csvPath?: string,
  batchSize = 50,
  waitTime = 40000,
  follow = true
): Promise<void> {
  // Default path or use provided path
  const defaultFileName = follow ? "follow.csv" : "block.csv";
  const filePath = csvPath || join(process.cwd(), "data", defaultFileName);

  if (!existsSync(filePath)) {
    logger.error(`CSV file not found at ${filePath}`);
    return;
  }

  // Read CSV file
  logger.info(`Reading user data from ${filePath}`);
  const fileContent = readFileSync(filePath, "utf-8");
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    delimiter: "\t",
    cast: (value, context) => {
      if (context.column === "user_id" || context.column === "video_count") {
        return parseInt(value, 10);
      }
      return value;
    },
  }) as UserFollowData[];

  logger.info(`Found ${records.length} users in CSV file`);
  const action = follow ? "follow" : "block";

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

    // Filter users based on action
    let usersToProcess = records;

    if (follow) {
      // For follow action, filter out users that are already being followed
      usersToProcess = records.filter(
        (record) => !currentFollowIds.has(record.user_id)
      );

      // Check if exceeding max follow limit
      if (usersToProcess.length > 4999 - currentFollowIds.size) {
        logger.warn(
          `Exceeding the maximum number of users that can be followed: ${usersToProcess.length} > ${
            4999 - currentFollowIds.size
          }`
        );
        usersToProcess.splice(4999 - currentFollowIds.size);
      }
    }

    logger.info(`Found ${usersToProcess.length} users to ${action}`);

    // Process in batches
    for (let i = 0; i < usersToProcess.length; i += batchSize) {
      const batchUsers = usersToProcess.slice(i, i + batchSize);
      const userIds = batchUsers.map((u) => u.user_id);

      logger.info(
        `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(usersToProcess.length / batchSize)}`
      );
      logger.debug(
        `${action === "follow" ? "Following" : "Blocking"} user IDs: ${userIds.join(", ")}`
      );

      try {
        const actionType = follow
          ? UserRelationAction.Follow
          : UserRelationAction.Block;

        const result = await batchModifyUserRelation(
          userIds,
          actionType,
          RelationSource.Profile,
          undefined,
          undefined
        );

        if (result.code === 0) {
          if (result.data.failed_fids.length === 0) {
            logger.info(
              `Successfully ${action === "follow" ? "followed" : "blocked"} ${userIds.length} users`
            );
          } else {
            logger.warn(
              `Failed to ${action} ${result.data.failed_fids.length} users: ${result.data.failed_fids.join(", ")}`
            );
          }
        } else {
          logger.error(`API Error: ${result.code} - ${result.message}`);
        }
      } catch (error) {
        logger.error(`Failed to ${action} users:`, error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
      }

      if (i + batchSize < usersToProcess.length) {
        let waitTime_thistime = waitTime * (0.5 + Math.random());
        logger.info(
          `Waiting ${waitTime_thistime / 1000} seconds before next batch...`
        );
        await sleep(waitTime_thistime);
      }
    }

    logger.info(`${follow ? "Follow" : "Block"} process completed`);
  } catch (error) {
    logger.error(`Failed to process ${follow ? "follows" : "blocks"}:`, error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
  }
}
