import { xClient } from "./client";
import { VideoTagResponse } from "../core/types";
import { logger } from "../utils/logger";

export const fetchVideoTags = async (
  bvid: string,
): Promise<VideoTagResponse> => {
  try {
    const response = await xClient.get<VideoTagResponse>(
      "/tag/archive/tags",
      { params: { bvid } },
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
