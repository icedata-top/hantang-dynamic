import type {
  BiliVideoDetailResponse,
  BiliVideoFullDetailResponse,
  VideoTagResponse,
} from "../types";
import { logger } from "../utils/logger";
import {
  type RequestConfig,
  webInterfaceClient,
  webInterfaceDirectClient,
} from "./client";
import { config } from "../config";

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

/**
 * Check if error is a 404/not found error
 */
function isNotFoundError(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 404 ||
        error.code === -404 ||
        error.code === 62002 ||
        error.code === 62012)) ||
    (error instanceof Error &&
      (error.message.includes("code -404") ||
        error.message.includes("code 62002") ||
        error.message.includes("code 62012")))
  );
}

export const fetchVideoFullDetail = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoFullDetailResponse | null> => {
  const endpoint = "/view/detail";
  const useProxy = !!config.bilibili.apiProxyUrl;

  // Try proxy first if configured
  if (useProxy) {
    try {
      const response =
        await webInterfaceClient.get<BiliVideoFullDetailResponse>(endpoint, {
          params,
          ...({ metadata: { silent: true } } as RequestConfig),
        });
      return response.data;
    } catch (proxyError) {
      // If proxy returns 404, fallback to direct API
      if (isNotFoundError(proxyError)) {
        logger.debug(
          `Proxy returned 404 for ${
            params.bvid || params.aid
          }, trying direct API`,
        );
      } else {
        // For other errors from proxy, log and try direct
        logger.warn(
          `Proxy error for ${
            params.bvid || params.aid
          }, falling back to direct API`,
          proxyError,
        );
      }
    }
  }

  // Try direct API (either as fallback or primary if no proxy)
  try {
    const response =
      await webInterfaceDirectClient.get<BiliVideoFullDetailResponse>(
        endpoint,
        {
          params,
          ...({ metadata: { silent: true } } as RequestConfig),
        },
      );
    return response.data;
  } catch (error) {
    if (isNotFoundError(error)) {
      logger.debug(
        `Video ${
          params.bvid || params.aid
        } not found (404/-404) - likely deleted`,
      );
      return null;
    }

    const baseUrl = webInterfaceDirectClient.defaults.baseURL || "";
    const fullUrl = `${baseUrl}${endpoint}?bvid=${params.bvid || ""}&aid=${
      params.aid || ""
    }`;
    logger.error(`API Error for URL: ${fullUrl}`, error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error(`API Error: Fetch video full detail failed (${fullUrl})`);
  }
};
