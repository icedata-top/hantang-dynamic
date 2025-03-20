import { xClient } from "./client";
import { logger } from "../utils/logger";
import {
  VideoTagResponse,
  BiliVideoDetailResponse,
  BiliVideoDescResponse,
  BiliVideoPageListResponse,
} from "../core/types";

export const fetchVideoTags = async (
  bvid: string,
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

export const fetchVideoDetail = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoDetailResponse> => {
  try {
    const response = await xClient.get<BiliVideoDetailResponse>(
      "/x/web-interface/view",
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
}): Promise<any> => {
  try {
    const response = await xClient.get<any>("/x/web-interface/view/detail", {
      params,
    });
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video full detail failed");
  }
};

export const fetchVideoDescription = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoDescResponse> => {
  try {
    const response = await xClient.get<BiliVideoDescResponse>(
      "/x/web-interface/archive/desc",
      { params },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video description failed");
  }
};

export const fetchVideoPageList = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoPageListResponse> => {
  try {
    const response = await xClient.get<BiliVideoPageListResponse>(
      "/x/player/pagelist",
      { params },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch video page list failed");
  }
};
