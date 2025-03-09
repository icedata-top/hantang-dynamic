import { xClient, accountClient } from "./client";
import { VideoTagResponse } from "../core/types";
import { logger } from "../utils/logger";

export const fetchVideoTags = async (
  bvid: string
): Promise<VideoTagResponse> => {
  try {
    const response = await xClient.get<VideoTagResponse>("/tag/archive/tags", {
      params: { bvid },
    });
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video tags failed");
  }
};

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
 * @param fid Target user's mid
 * @param act Action code (see UserRelationAction enum)
 * @param reSource Source of the operation (see RelationSource enum)
 * @param accessKey APP login token (required for app authentication)
 * @param csrf CSRF token (required for cookie authentication)
 * @returns API response
 */
export const modifyUserRelation = async (
  fid: number,
  act: UserRelationAction,
  reSource: RelationSource = RelationSource.Profile,
  accessKey?: string,
  csrf?: string
): Promise<RelationModifyResponse> => {
  if (!accessKey && !csrf) {
    throw new Error(
      "Authentication required: provide either accessKey or csrf"
    );
  }

  try {
    const formData = new URLSearchParams();
    formData.append("fid", fid.toString());
    formData.append("act", act.toString());
    formData.append("re_src", reSource.toString());

    if (accessKey) {
      formData.append("access_key", accessKey);
    }

    if (csrf) {
      formData.append("csrf", csrf);
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
 * @param fids Array of target user mids
 * @param act Action code (only UserRelationAction.Follow or UserRelationAction.Block)
 * @param reSource Source of the operation (see RelationSource enum)
 * @param accessKey APP login token (required for app authentication)
 * @param csrf CSRF token (required for cookie authentication)
 * @returns API response with list of failed operations
 */
export const batchModifyUserRelation = async (
  fids: number[],
  act: UserRelationAction.Follow | UserRelationAction.Block,
  reSource: RelationSource = RelationSource.Profile,
  accessKey?: string,
  csrf?: string
): Promise<BatchRelationModifyResponse> => {
  if (!accessKey && !csrf) {
    throw new Error(
      "Authentication required: provide either accessKey or csrf"
    );
  }

  if (act !== UserRelationAction.Follow && act !== UserRelationAction.Block) {
    throw new Error("Batch operation only supports Follow (1) or Block (5)");
  }

  try {
    const formData = new URLSearchParams();
    formData.append("fids", fids.join(","));
    formData.append("act", act.toString());
    formData.append("re_src", reSource.toString());

    if (accessKey) {
      formData.append("access_key", accessKey);
    }

    if (csrf) {
      formData.append("csrf", csrf);
    }

    const response = await xClient.post<BatchRelationModifyResponse>(
      "/relation/batch/modify",
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
    throw new Error("API Error: Failed to batch modify user relations");
  }
};

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
