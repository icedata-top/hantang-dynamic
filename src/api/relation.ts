import { xClient, accountClient } from "./client";
import { VideoTagResponse } from "../core/types";
import { logger } from "../utils/logger";
import { config } from "../core/config";

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
  csrf?: string
): Promise<RelationModifyResponse> => {
  // Check if feature is enabled in config
  if (!config.ENABLE_USER_RELATION) {
    throw new Error("User relation operations are disabled in configuration");
  }

  // Use provided credentials or fall back to config values
  const useAccessKey = accessKey || config.BILI_ACCESS_KEY;
  const useCsrf = csrf || config.BILI_JCT;

  if (!useAccessKey && !useCsrf) {
    throw new Error(
      "Authentication required: provide either accessKey or csrf in function call or configuration"
    );
  }

  try {
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

    const response = await xClient.post<RelationModifyResponse>(
      "/relation/modify",
      formData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Failed to modify user relation");
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
  act: UserRelationAction.Follow | UserRelationAction.Block,
  reSource: RelationSource = RelationSource.Profile,
  accessKey?: string,
  csrf?: string
): Promise<BatchRelationModifyResponse> => {
  // Check if feature is enabled in config
  if (!config.ENABLE_USER_RELATION) {
    throw new Error("User relation operations are disabled in configuration");
  }

  // Use provided credentials or fall back to config values
  const useAccessKey = accessKey || config.BILI_ACCESS_KEY;
  const useCsrf = csrf || config.BILI_JCT;

  if (!useAccessKey && !useCsrf) {
    throw new Error(
      "Authentication required: provide either accessKey or csrf in function call or configuration"
    );
  }

  if (act !== UserRelationAction.Follow && act !== UserRelationAction.Block) {
    throw new Error("Batch operation only supports Follow (1) or Block (5)");
  }

  if (fids.length === 0) {
    logger.warn("Empty user ID list provided for batch modification");
    return {
      code: 0,
      message: "No users to process",
      ttl: 1,
      data: {
        failed_fids: [],
      },
    };
  }

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
      `Batch modifying user relations: ${fids.length} users, Action ${act}`
    );
    const response = await xClient.post<BatchRelationModifyResponse>(
      "/relation/batch/modify",
      formData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    // Log failed operations if any
    if (response.data.data?.failed_fids?.length > 0) {
      logger.warn(
        `Failed to modify relation for ${response.data.data.failed_fids.length} users: ${response.data.data.failed_fids.join(", ")}`
      );
    }

    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Failed to batch modify user relations");
  }
};

/**
 * Fetch a list of users that the specified user follows
 * @param userid User's mid to get the following list for
 * @returns Object containing array of user IDs that are followed by the specified user
 */
export const fetchUserRelation = async (
  userid: string
): Promise<{ attentions: bigint[] }> => {
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

    if (response.data.code !== 0) {
      throw new Error(`API Error: ${response.data.code}`);
    }

    // Return the relationship data with focus on attentions
    return { attentions: response.data.card.attentions || [] };
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Failed to fetch user relation");
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

  if (!config.ENABLE_USER_RELATION) {
    return {
      enabled: false,
      hasAuth: false,
      missingConfig: ["ENABLE_USER_RELATION"],
    };
  }

  if (!config.BILI_JCT && !config.BILI_ACCESS_KEY) {
    missingConfig.push("BILI_JCT or BILI_ACCESS_KEY");
  }

  return {
    enabled: true,
    hasAuth: !missingConfig.includes("BILI_JCT or BILI_ACCESS_KEY"),
    missingConfig,
  };
};
