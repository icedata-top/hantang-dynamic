import type {
  BiliVideoDetailResponse,
  BiliVideoFullDetailResponse,
  VideoTagResponse,
} from "../types";
import { logger } from "../utils/logger";
import { webInterfaceClient } from "./client";

export const fetchVideoTags = async (
  bvid: string,
  aid?: number,
): Promise<VideoTagResponse> => {
  try {
    const response = await webInterfaceClient.get<VideoTagResponse>(
      "/view/detail/tag",
      {
        params: { bvid, aid },
      },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video tags failed");
  }
};

export const fetchVideoDetail = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoDetailResponse> => {
  try {
    const response = await webInterfaceClient.get<BiliVideoDetailResponse>(
      "/view",
      { params },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video detail failed");
  }
};

export const fetchVideoFullDetail = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoFullDetailResponse> => {
  try {
    const response = await webInterfaceClient.get<BiliVideoFullDetailResponse>(
      "/view/detail",
      {
        params,
      },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video full detail failed");
  }
};
