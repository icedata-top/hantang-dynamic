import { parse } from "csv-parse/sync";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  batchModifyUserRelation,
  checkUserRelationConfig,
  fetchUserRelation,
  RelationSource,
  UserRelationAction,
} from "../api/relation";
import { config } from "../config";
import { retryDelay, sleep } from "./datetime";
import { logger } from "./logger";

interface UserRelationData {
  user_id: number;
  video_count?: number;
  reason?: string;
}

/**
 * User relation manager for following, unfollowing, blocking and unblocking operations
 */
export class UserRelationManager {
  /**
   * Get user-friendly name for a relation action
   */
  static getActionName(action: UserRelationAction): string {
    switch (action) {
      case UserRelationAction.Follow:
        return "follow";
      case UserRelationAction.Unfollow:
        return "unfollow";
      case UserRelationAction.Block:
        return "block";
      case UserRelationAction.Unblock:
        return "unblock";
      case UserRelationAction.RemoveFollower:
        return "remove follower";
      default:
        return "unknown action";
    }
  }

  /**
   * Get default CSV filename for a relation action
   */
  static getDefaultFilename(action: UserRelationAction): string {
    switch (action) {
      case UserRelationAction.Follow:
        return "follow.csv";
      case UserRelationAction.Unfollow:
        return "unfollow.csv";
      case UserRelationAction.Block:
        return "block.csv";
      case UserRelationAction.Unblock:
        return "unblock.csv";
      case UserRelationAction.RemoveFollower:
        return "remove-followers.csv";
      default:
        return "users.csv";
    }
  }

  /**
   * Process user relations based on specified action type
   * @param actionType The relation action to perform
   * @param csvPath Optional path to CSV file, defaults based on action type
   * @param batchSize Number of users to process in each batch
   * @param waitTime Base time to wait between batches in ms
   */
  static async processUserRelations(
    actionType: UserRelationAction,
    csvPath?: string,
    batchSize = 50,
    waitTime = 40000,
  ): Promise<void> {
    // Validate configuration
    const configStatus = checkUserRelationConfig();
    if (!configStatus.enabled || !configStatus.hasAuth) {
      logger.error(
        `User relation feature is not properly configured: ${configStatus.missingConfig.join(", ")}`,
      );
      return;
    }

    const actionName = UserRelationManager.getActionName(actionType);
    const defaultFileName = UserRelationManager.getDefaultFilename(actionType);

    // Default path or use provided path
    const filePath = csvPath || join(process.cwd(), "data", defaultFileName);

    if (!existsSync(filePath)) {
      logger.error(`CSV file not found at ${filePath}`);
      return;
    }

    // Read CSV file
    logger.info(
      `Reading user data for ${actionName} operation from ${filePath}`,
    );
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
    }) as UserRelationData[];

    logger.info(`Found ${records.length} users in CSV file`);

    // Get current follows if needed for filtering
    let currentFollowIds: Set<number> = new Set();

    if (
      actionType === UserRelationAction.Follow ||
      actionType === UserRelationAction.Unfollow
    ) {
      try {
        const currentFollows = await retryDelay(
          () => fetchUserRelation(config.bilibili.uid),
          config.application.apiRetryTimes,
          config.application.apiWaitTime,
        );

        currentFollowIds = new Set(
          currentFollows.attentions.map((id) => Number(id)),
        );
        logger.info(`Currently following ${currentFollowIds.size} users`);
      } catch (error) {
        logger.error("Failed to fetch current follow list:", error);
        return;
      }
    }

    // Filter users based on action
    let usersToProcess = records;

    if (actionType === UserRelationAction.Follow) {
      // For follow action, filter out users that are already being followed
      usersToProcess = records.filter(
        (record) => !currentFollowIds.has(record.user_id),
      );

      // Check if exceeding max follow limit
      if (usersToProcess.length > 4999 - currentFollowIds.size) {
        logger.warn(
          `Exceeding the maximum number of users that can be followed: ${usersToProcess.length} > ${
            4999 - currentFollowIds.size
          }`,
        );
        usersToProcess = usersToProcess.slice(0, 4999 - currentFollowIds.size);
      }
    } else if (actionType === UserRelationAction.Unfollow) {
      // For unfollow action, only process users that are currently being followed
      usersToProcess = records.filter((record) =>
        currentFollowIds.has(record.user_id),
      );
    }

    logger.info(`Found ${usersToProcess.length} users to ${actionName}`);
    if (usersToProcess.length === 0) {
      logger.info(`No users to ${actionName}, operation completed`);
      return;
    }

    // Process in batches
    for (let i = 0; i < usersToProcess.length; i += batchSize) {
      const batchUsers = usersToProcess.slice(i, i + batchSize);
      const userIds = batchUsers.map((u) => u.user_id);

      logger.info(
        `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(usersToProcess.length / batchSize)}`,
      );
      logger.debug(
        `${actionName.charAt(0).toUpperCase() + actionName.slice(1)}ing user IDs: ${userIds.join(", ")}`,
      );

      try {
        const result = await batchModifyUserRelation(
          userIds,
          actionType,
          RelationSource.Profile,
          undefined,
          undefined,
        );

        if (result.code === 0) {
          if (result.data.failed_fids.length === 0) {
            logger.info(`Successfully ${actionName}ed ${userIds.length} users`);
          } else {
            logger.warn(
              `Failed to ${actionName} ${result.data.failed_fids.length} users: ${result.data.failed_fids.join(", ")}`,
            );
          }
        } else {
          logger.error(`API Error: ${result.code} - ${result.message}`);
        }
      } catch (error) {
        logger.error(`Failed to ${actionName} users:`, error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
      }

      if (i + batchSize < usersToProcess.length) {
        const waitTimeThisBatch = waitTime * (0.5 + Math.random());
        logger.info(
          `Waiting ${Math.round(waitTimeThisBatch / 1000)} seconds before next batch...`,
        );
        await sleep(waitTimeThisBatch);
      }
    }

    logger.info(
      `${actionName.charAt(0).toUpperCase() + actionName.slice(1)} process completed`,
    );
  }
}
