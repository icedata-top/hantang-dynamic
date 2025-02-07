import { videoClient } from "./client";
import { VideoTagResponse } from "../core/types";

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
    console.error("API Error:", error);
    throw new Error("API Error: Fetch video tags failed");
  }
};
