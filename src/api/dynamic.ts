import type { AxiosInstance } from "axios";
import type { BiliDynamicFeedResponse } from "../types";
import { dynamicClient, type RequestConfig } from "./client";

export interface DynamicFeedRequestOptions {
  /** 1-based page number within the current scan, used for diagnostics. */
  page?: number;
}

export async function getDynamicFeed(
  offset?: string,
  client: AxiosInstance = dynamicClient,
  options: DynamicFeedRequestOptions = {},
): Promise<BiliDynamicFeedResponse> {
  const requestConfig = {
    params: {
      type: "all",
      platform: "web",
      ...(offset ? { offset } : {}),
    },
    // Business codes are handled by the feed pagination loop; do not notify
    // on every unreachable deep page.
    rawApiErrors: true,
  } as RequestConfig;
  if (options.page !== undefined) {
    requestConfig.metadata = { feedPage: options.page };
  }

  const response = await client.get<BiliDynamicFeedResponse>(
    "/feed/all",
    requestConfig,
  );
  return response.data;
}
