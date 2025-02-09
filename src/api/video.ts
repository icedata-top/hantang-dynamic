import { videoClient } from "./client";
import { VideoTagResponse } from "../core/types";
import { logger } from "../utils/logger";

export const fetchVideoTags = async (
  bvid: string,
): Promise<VideoTagResponse> => {
  try {
    const response = await videoClient.get<VideoTagResponse>(
      "/tag/archive/tags",
      { params: { bvid } },
    );
    return response.data;
  } catch (error) {
    logger.error("API Error:", error);
    throw new Error("API Error: Fetch video tags failed");
  }
};
