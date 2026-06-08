import { config } from "../config";
import type {
  BiliVideoBatchDetailItemResponse,
  BiliVideoBatchDetailResponse,
  BiliVideoFullDetailResponse,
} from "../types";
import { logger } from "../utils/logger";
import {
  type RequestConfig,
  webInterfaceClient,
  webInterfaceDirectClient,
} from "./client";

const UNAVAILABLE_CODES = [62002, 62004, 62012];

/**
 * Check if error is a 404/not found error (HTTP-level or interceptor-level)
 */
function isNotFoundError(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 404 || error.code === -404)) ||
    (error instanceof Error &&
      (error.message.includes("code -404") ||
        error.message.includes("code 404")))
  );
}

type VideoBatchResponse = {
  data: BiliVideoBatchDetailResponse;
};

function isHtmlNotFoundError(error: unknown): boolean {
  return (
    isNotFoundError(error) &&
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "string" &&
    error.data.toLowerCase().includes("<html")
  );
}

/**
 * Validate response code from the video detail endpoint.
 * - code 0: return data as-is
 * - 404 / -404: return null (deleted)
 * - 62002 / 62004 / 62012: throw VIDEO_UNAVAILABLE (invisible/under review/private)
 */
function checkResponseCode(
  data: BiliVideoFullDetailResponse,
  id: string | number | undefined,
): BiliVideoFullDetailResponse | null {
  if (data.code === 0) return data;
  if (data.code === 404 || data.code === -404) return null;
  if (UNAVAILABLE_CODES.includes(data.code)) {
    throw new Error(`VIDEO_UNAVAILABLE:${id}:${data.code}:${data.message}`);
  }
  throw new Error(`API Error: code ${data.code}`);
}

export const fetchVideoFullDetail = async (params: {
  aid?: number;
  bvid?: string;
}): Promise<BiliVideoFullDetailResponse | null> => {
  const endpoint = "/view/detail";
  const useProxy = !!config.bilibili.apiProxyUrl;
  const id = params.bvid || params.aid;

  // Try proxy first if configured
  if (useProxy) {
    try {
      const response =
        await webInterfaceClient.get<BiliVideoFullDetailResponse>(endpoint, {
          params,
          ...({ metadata: { silent: true } } as RequestConfig),
        });
      return checkResponseCode(response.data, id);
    } catch (proxyError) {
      // VIDEO_UNAVAILABLE is definitive — don't retry on direct
      if (
        proxyError instanceof Error &&
        proxyError.message.startsWith("VIDEO_UNAVAILABLE:")
      ) {
        throw proxyError;
      }
      // If proxy returns 404, fallback to direct API
      if (isNotFoundError(proxyError)) {
        logger.debug(`Proxy returned 404 for ${id}, trying direct API`);
      } else {
        // For other errors from proxy (e.g. -403, -400), log and try direct
        logger.warn(
          `Proxy error for ${id}, falling back to direct API`,
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
    return checkResponseCode(response.data, id);
  } catch (error) {
    // VIDEO_UNAVAILABLE propagates directly
    if (
      error instanceof Error &&
      error.message.startsWith("VIDEO_UNAVAILABLE:")
    ) {
      throw error;
    }
    if (isNotFoundError(error)) {
      logger.debug(`Video ${id} not found (404/-404) - likely deleted`);
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

export const fetchVideoFullDetailBatch = async (
  ids: string[],
  concurrency?: number,
): Promise<BiliVideoBatchDetailItemResponse[]> => {
  if (!config.bilibili.apiProxyUrl) {
    throw new Error("Video detail batch requires bilibili.apiProxyUrl");
  }

  const endpoint = "/view/detail/batch";
  let response: VideoBatchResponse;
  try {
    response = await webInterfaceClient.post<BiliVideoBatchDetailResponse>(
      endpoint,
      {
        concurrency,
        ids,
      },
      { metadata: { silent: true } } as RequestConfig,
    );
  } catch (error) {
    if (isHtmlNotFoundError(error)) {
      logger.debug(
        `Video detail batch returned HTML 404 for ${ids.length} id(s); treating batch items as deleted`,
      );
      return ids.map((id) => ({
        id,
        code: 404,
        message: "HTTP 404",
      }));
    }
    throw error;
  }

  if (response.data.code !== 0) {
    if (response.data.code === 404 || response.data.code === -404) {
      return ids.map((id) => ({
        id,
        code: response.data.code,
        message: response.data.message,
      }));
    }

    throw new Error(
      `API Error: batch code ${response.data.code}: ${response.data.message}`,
    );
  }

  return response.data.data;
};
