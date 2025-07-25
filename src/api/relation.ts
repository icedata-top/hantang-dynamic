import { config } from "../config";
import { VideoTagResponse } from "../core/types";
import { getRandomDelay, sleep } from "../utils/datetime";
import { logger } from "../utils/logger";
import { accountClient, simulateBrowserVisit, xClient } from "./client";

// User relationship operation types
export enum UserRelationAction {
  Follow = 1,
  Unfollow = 2,
  // SilentFollow = 3, // Deprecated operation
  // CancelSilentFollow = 4, // Deprecated operation
  Block = 5,
  Unblock = 6,
  RemoveFollower = 7,
}

// Source of relationship operation
export enum RelationSource {
  Profile = 11,
  Video = 14,
  Article = 115,
  ActivityPage = 222,
}

export enum RelationErrorCode {
  Success = 0,
  NotLoggedIn = -101,
  AccountBanned = -102,
  CSRFCheckFailed = -111,
  RequestError = -400,
  SelfOperation = 22001,
  PrivacyRestriction = 22002,
  UserBlacklisted = 22003,
  AccountDeleted = 22013,
  AlreadyFollowing = 22014,
  DuplicateBlacklist = 22120,
  UserNotExist = 40061,
}

interface RelationModifyResponse {
  code: number;
  message: string;
  ttl: number;
}

interface BatchRelationModifyResponse {
  code: number;
  message: string;
  ttl: number;
  data: {
    failed_fids: number[];
  };
}

/**
 * Simulate a visit to a user's space page with appropriate referrer
 * @param fid Target user's mid
 * @param reSource Source of the operation
 */
const simulateUserPageVisit = async (
  fid: number,
  reSource: RelationSource,
): Promise<void> => {
  const url = `https://space.bilibili.com/${fid}`;

  let referrer = "https://www.bilibili.com/";
  switch (reSource) {
    case RelationSource.Video:
      referrer = `https://www.bilibili.com/video/av${getRandomDelay(10000, 999999)}`;
      break;
    case RelationSource.Article:
      referrer = `https://www.bilibili.com/read/cv${getRandomDelay(10000, 999999)}`;
      break;
    case RelationSource.ActivityPage:
      referrer = "https://t.bilibili.com/";
      break;
  }

  await simulateBrowserVisit(url, referrer);
};

/**
 * Get human-readable error message from API error code
 * @param code API error code
 * @returns Human-readable error message
 */
const getErrorMessage = (code: number): string => {
  switch (code) {
    case RelationErrorCode.Success:
      return "Operation successful";
    case RelationErrorCode.NotLoggedIn:
      return "Account not logged in";
    case RelationErrorCode.AccountBanned:
      return "Account has been banned";
    case RelationErrorCode.CSRFCheckFailed:
      return "CSRF verification failed";
    case RelationErrorCode.RequestError:
      return "Request error";
    case RelationErrorCode.SelfOperation:
      return "Cannot perform this operation on yourself";
    case RelationErrorCode.PrivacyRestriction:
      return "Cannot follow due to user's privacy settings";
    case RelationErrorCode.UserBlacklisted:
      return "User is blacklisted";
    case RelationErrorCode.AccountDeleted:
      return "Account has been deleted";
    case RelationErrorCode.AlreadyFollowing:
      return "Already following this user";
    case RelationErrorCode.DuplicateBlacklist:
      return "User is already in blacklist";
    case RelationErrorCode.UserNotExist:
      return "User does not exist";
    default:
      return `Unknown error (${code})`;
  }
};

/**
 * Automatically unblock a user if they're in the blacklist when trying to follow them
 * @param fid Target user's mid
 * @param reSource Source of the operation
 * @param accessKey Optional APP login token
 * @param csrf Optional CSRF token
 * @returns Whether unblocking was successful
 */
const autoUnblockUser = async (
  fid: number,
  reSource: RelationSource,
  accessKey?: string,
  csrf?: string,
): Promise<boolean> => {
  try {
    logger.info(
      `User ${fid} is in blacklist. Attempting to unblock before following...`,
    );
    const unblockResponse = await modifyUserRelation(
      fid,
      UserRelationAction.Unblock,
      reSource,
      accessKey,
      csrf,
    );

    if (unblockResponse.code === RelationErrorCode.Success) {
      logger.info(`Successfully unblocked user ${fid}`);
      await sleep(getRandomDelay(300, 500));
      return true;
    } else {
      logger.warn(
        `Failed to unblock user ${fid}: ${getErrorMessage(unblockResponse.code)}`,
      );
      return false;
    }
  } catch (error) {
    logger.error(`Error while trying to unblock user ${fid}:`, error);
    return false;
  }
};

/**
 * Modify relationship with a single user (follow, unfollow, block, etc.)
 * Uses configuration values for authentication if specific credentials aren't provided
 * @param fid Target user's mid
 * @param act Action code (see UserRelationAction enum)
 * @param reSource Source of the operation (see RelationSource enum)
 * @param accessKey Optional override for APP login token
 * @param csrf Optional override for CSRF token
 * @returns API response
 */
export const modifyUserRelation = async (
  fid: number,
  act: UserRelationAction,
  reSource: RelationSource = RelationSource.Profile,
  accessKey?: string,
  csrf?: string,
): Promise<RelationModifyResponse> => {
  // Check if feature is enabled in config
  if (!config.processing.features.enableUserRelation) {
    return {
      code: RelationErrorCode.RequestError,
      message: "User relation operations are disabled in configuration",
      ttl: 1,
    };
  }

  // Use provided credentials or fall back to config values
  const useAccessKey = accessKey || config.bilibili.accessKey;
  const useCsrf = csrf || config.bilibili.csrfToken;

  if (!useAccessKey && !useCsrf) {
    return {
      code: RelationErrorCode.NotLoggedIn,
      message: "Authentication required: provide either accessKey or csrf",
      ttl: 1,
    };
  }

  try {
    // Visit user's page first to set referrer (except for unblock operations to prevent loops)
    if (act !== UserRelationAction.Unblock) {
      try {
        await simulateUserPageVisit(fid, reSource);
      } catch (error) {
        // Just log the error and continue with the operation
        logger.warn(`Failed to simulate page visit for user ${fid}: ${error}`);
      }
    }

    const formData = new URLSearchParams();
    formData.append("fid", fid.toString());
    formData.append("act", act.toString());
    formData.append("re_src", reSource.toString());

    if (useAccessKey) {
      formData.append("access_key", useAccessKey);
    }

    if (useCsrf) {
      formData.append("csrf", useCsrf);
    }

    try {
      const response = await xClient.post<RelationModifyResponse>(
        "/relation/modify",
        formData,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      // Auto-unblock handling: if trying to follow and user is blacklisted (code 22003)
      if (
        act === UserRelationAction.Follow &&
        response.data.code === RelationErrorCode.UserBlacklisted
      ) {
        const unblocked = await autoUnblockUser(
          fid,
          reSource,
          useAccessKey,
          useCsrf,
        );
        if (unblocked) {
          // Retry the follow operation after unblocking
          return modifyUserRelation(fid, act, reSource, useAccessKey, useCsrf);
        }
      }

      // For certain errors we can return a success to avoid interrupting batch operations
      // These are cases where the desired state is already achieved
      if (
        act === UserRelationAction.Follow &&
        response.data.code === RelationErrorCode.AlreadyFollowing
      ) {
        logger.info(
          `User ${fid} is already being followed, treating as success`,
        );
        return {
          code: RelationErrorCode.Success,
          message: "Already following",
          ttl: 1,
        };
      } else if (
        (act === UserRelationAction.Unfollow ||
          act === UserRelationAction.Follow ||
          act === UserRelationAction.RemoveFollower ||
          act === UserRelationAction.Block ||
          act === UserRelationAction.Unblock) &&
        (response.data.code === RelationErrorCode.UserNotExist ||
          response.data.code === RelationErrorCode.AccountDeleted)
      ) {
        logger.info(
          `Cannot change non-existent user ${fid}, treating as success`,
        );
        return {
          code: RelationErrorCode.Success,
          message: "User doesn't exist",
          ttl: 1,
        };
      }

      // Log error codes and messages for debugging
      if (response.data.code !== RelationErrorCode.Success) {
        logger.warn(
          `Relation action ${act} on user ${fid} returned error: ${getErrorMessage(response.data.code)}`,
        );
      } else {
        logger.debug(
          `Successfully performed relation action ${act} on user ${fid}`,
        );
      }

      return response.data;
    } catch (error) {
      logger.error(
        `Network error during relation modification for user ${fid}:`,
        error,
      );
      return {
        code: RelationErrorCode.RequestError,
        message: error instanceof Error ? error.message : "Network error",
        ttl: 1,
      };
    }
  } catch (error) {
    logger.error("Unexpected error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return {
      code: RelationErrorCode.RequestError,
      message: error instanceof Error ? error.message : "Unknown error",
      ttl: 1,
    };
  }
};

/**
 * Batch modify user relationships (follow or block multiple users at once)
 * Uses configuration values for authentication if specific credentials aren't provided
 * @param fids Array of target user mids
 * @param act Action code (only UserRelationAction.Follow or UserRelationAction.Block)
 * @param reSource Source of the operation (see RelationSource enum)
 * @param accessKey Optional override for APP login token
 * @param csrf Optional override for CSRF token
 * @returns API response with list of failed operations
 */
export const batchModifyUserRelation = async (
  fids: number[],
  act: UserRelationAction,
  reSource: RelationSource = RelationSource.Profile,
  accessKey?: string,
  csrf?: string,
): Promise<BatchRelationModifyResponse> => {
  // Check if feature is enabled in config
  if (!config.processing.features.enableUserRelation) {
    return {
      code: RelationErrorCode.RequestError,
      message: "User relation operations are disabled in configuration",
      ttl: 1,
      data: { failed_fids: fids },
    };
  }

  // Use provided credentials or fall back to config values
  const useAccessKey = accessKey || config.bilibili.accessKey;
  const useCsrf = csrf || config.bilibili.csrfToken;

  if (!useAccessKey && !useCsrf) {
    return {
      code: RelationErrorCode.NotLoggedIn,
      message: "Authentication required: provide either accessKey or csrf",
      ttl: 1,
      data: { failed_fids: fids },
    };
  }

  if (fids.length === 0) {
    logger.warn("Empty user ID list provided for batch modification");
    return {
      code: RelationErrorCode.Success,
      message: "No users to process",
      ttl: 1,
      data: { failed_fids: [] },
    };
  }

  if (fids.length === 1) {
    logger.warn(
      "Single user ID provided for batch modification, using single operation",
    );
    const singleResponse = await modifyUserRelation(
      fids[0],
      act,
      reSource,
      useAccessKey,
      useCsrf,
    );
    return {
      ...singleResponse,
      data: {
        failed_fids:
          singleResponse.code === RelationErrorCode.Success ? [] : [fids[0]],
      },
    };
  }

  // For Follow and Block operations, use the API batch endpoint
  if (act === UserRelationAction.Follow || act === UserRelationAction.Block) {
    try {
      const formData = new URLSearchParams();
      formData.append("fids", fids.join(","));
      formData.append("act", act.toString());
      formData.append("re_src", reSource.toString());

      if (useAccessKey) {
        formData.append("access_key", useAccessKey);
      }

      if (useCsrf) {
        formData.append("csrf", useCsrf);
      }

      logger.debug(
        `Batch modifying user relations: ${fids.length} users, Action ${act}`,
      );

      try {
        const response = await xClient.post<BatchRelationModifyResponse>(
          "/relation/batch/modify",
          formData,
          {
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
          },
        );

        // Log failed operations if any
        if (response.data.data?.failed_fids?.length > 0) {
          logger.warn(
            `Failed to modify relation for ${response.data.data.failed_fids.length} users: ${response.data.data.failed_fids.join(", ")}`,
          );
          logger.warn(`API Message: ${getErrorMessage(response.data.code)}`);
        }

        return response.data;
      } catch (error) {
        // Handle network errors gracefully by falling back to individual operations
        logger.warn(
          `Batch operation failed, falling back to individual requests: ${error}`,
        );
        return processIndividually(fids, act, reSource, useAccessKey, useCsrf);
      }
    } catch (error) {
      // Handle unexpected errors without crashing
      logger.error("API Error:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }

      return {
        code: RelationErrorCode.RequestError,
        message: error instanceof Error ? error.message : "Unknown error",
        ttl: 1,
        data: { failed_fids: fids },
      };
    }
  } else {
    // For other actions that don't support batch operations, perform individual operations
    logger.info(
      `Operation ${act} doesn't support batching, falling back to individual requests`,
    );
    return processIndividually(fids, act, reSource, useAccessKey, useCsrf);
  }
};

/**
 * Helper function to process users individually with random delays
 */
const processIndividually = async (
  fids: number[],
  act: UserRelationAction,
  reSource: RelationSource,
  accessKey?: string,
  csrf?: string,
): Promise<BatchRelationModifyResponse> => {
  const results = {
    code: RelationErrorCode.Success,
    message: "0",
    ttl: 1,
    data: {
      failed_fids: [] as number[],
    },
  };

  // Process each user individually with random delays
  for (const fid of fids) {
    try {
      // Add random delay between requests (1-3 seconds)
      if (fids.indexOf(fid) > 0) {
        const delay = getRandomDelay(1000, 3000);
        logger.debug(`Waiting ${delay}ms before processing next user...`);
        await sleep(delay);
      }

      const response = await modifyUserRelation(
        fid,
        act,
        reSource,
        accessKey,
        csrf,
      );

      if (response.code !== RelationErrorCode.Success) {
        logger.warn(
          `Failed to modify relation for user ${fid}: ${getErrorMessage(response.code)}`,
        );
        results.data.failed_fids.push(fid);
      } else {
        logger.debug(`Successfully modified relation for user ${fid}`);
      }
    } catch (error) {
      logger.error(`Error processing user ${fid}:`, error);
      results.data.failed_fids.push(fid);
    }
  }

  // If all operations failed, set an error code
  if (results.data.failed_fids.length === fids.length) {
    results.code = RelationErrorCode.RequestError;
    results.message = "All operations failed";
  }

  return results;
};

/**
 * Fetch a list of users that the specified user follows
 * @param userid User's mid to get the following list for
 * @returns Object containing array of user IDs that are followed by the specified user
 */
export const fetchUserRelation = async (
  userid: string,
): Promise<{ attentions: bigint[] }> => {
  try {
    try {
      const response = await accountClient.get<{
        ts: number;
        code: number;
        card: {
          mid: string;
          name: string;
          face: string;
          attention: number; // Total number of people user follows
          fans: number; // Total number of user's followers
          friend: number; // Total number of mutual follows
          attentions: bigint[]; // Array of user IDs that this user follows
        };
      }>("/member/getCardByMid", {
        params: { mid: userid },
      });

      if (response.data.code !== RelationErrorCode.Success) {
        logger.warn(
          `Failed to fetch user relations: ${getErrorMessage(response.data.code)}`,
        );
        return { attentions: [] };
      }

      // Return the relationship data with focus on attentions
      return { attentions: response.data.card.attentions || [] };
    } catch (error) {
      // Handle network errors gracefully
      logger.error(
        `Network error while fetching user relations for ${userid}:`,
        error,
      );
      return { attentions: [] };
    }
  } catch (error) {
    // Handle unexpected errors without crashing
    logger.error("Unexpected error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return { attentions: [] };
  }
};

/**
 * Check if the user relation modification feature is enabled and properly configured
 * @returns Object with status and any missing configuration details
 */
export const checkUserRelationConfig = (): {
  enabled: boolean;
  hasAuth: boolean;
  missingConfig: string[];
} => {
  const missingConfig: string[] = [];

  if (!config.processing.features.enableUserRelation) {
    return {
      enabled: false,
      hasAuth: false,
      missingConfig: ["ENABLE_USER_RELATION"],
    };
  }

  if (!config.bilibili.csrfToken && !config.bilibili.accessKey) {
    missingConfig.push("BILI_JCT or BILI_ACCESS_KEY");
  }

  return {
    enabled: true,
    hasAuth: !missingConfig.includes("BILI_JCT or BILI_ACCESS_KEY"),
    missingConfig,
  };
};
