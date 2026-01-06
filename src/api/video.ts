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
}): Promise<BiliVideoFullDetailResponse | null> => {
  const endpoint = "/view/detail";
  const baseUrl = webInterfaceClient.defaults.baseURL || "";
  const fullUrl = `${baseUrl}${endpoint}?bvid=${params.bvid || ""}&aid=${
    params.aid || ""
  }`;

  try {
    const response = await webInterfaceClient.get<BiliVideoFullDetailResponse>(
      endpoint,
      {
        params,
      },
    );
    return response.data;
  } catch (error) {
    // Handle 404 errors gracefully - video was deleted, which is normal
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 404
    ) {
      logger.debug(
        `Video ${params.bvid || params.aid} not found (404) - likely deleted`,
      );
      return null;
    }

    logger.error(`API Error for URL: ${fullUrl}`, error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error(`API Error: Fetch video full detail failed (${fullUrl})`);
  }
};
