import type { AxiosInstance } from "axios";
import type { BiliDynamicFeedResponse } from "../types";
import { dynamicClient } from "./client";

export async function getDynamicFeed(
  offset?: string,
  client: AxiosInstance = dynamicClient,
): Promise<BiliDynamicFeedResponse> {
  const response = await client.get<BiliDynamicFeedResponse>("/feed/all", {
    params: {
      type: "all",
      platform: "web",
      ...(offset ? { offset } : {}),
    },
  });
  return response.data;
}
