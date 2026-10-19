import type { AxiosInstance } from "axios";
import type { BiliDynamicFeedResponse } from "../types";
import { dynamicClient, type RequestConfig } from "./client";

export interface DynamicFeedRequestOptions {
  /** 1-based page number within the current scan, used for diagnostics. */
  page?: number;
}

/**
 * Business code returned when the feed cursor can no longer be served. It
 * shows up at a stable depth near the end of the reachable feed, and may also
 * be transient, so the feed loop decides whether to retry or stop.
 */
export const FEED_END_CODE = 4101133;

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
  requestConfig.metadata = {
    ...(options.page === undefined ? {} : { feedPage: options.page }),
    expectedApiCodes: [FEED_END_CODE],
  };

  const response = await client.get<BiliDynamicFeedResponse>(
    "/feed/all",
    requestConfig,
  );
  return response.data;
}
