import type { AxiosInstance } from "axios";
import { config } from "../config";
import type {
  BiliDynamicDetailResponse,
  BiliDynamicHistoryResponse,
  BiliDynamicNewResponse,
} from "../types";
import { logger } from "../utils/logger";
import {
  dynamicClient,
  dynamicDetailClient,
  isAccountAuthError,
} from "./client";

const fetchDynamicsAPI = async (
  endpoint: string,
  params: Record<string, string | number | bigint>,
  client: AxiosInstance = dynamicClient,
): Promise<BiliDynamicNewResponse | BiliDynamicHistoryResponse> => {
  try {
    const response = await client.get<
      BiliDynamicNewResponse | BiliDynamicHistoryResponse
    >(endpoint, {
      params,
    });
    return response.data;
  } catch (error) {
    if (isAccountAuthError(error)) {
      throw error;
    }
    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch dynamics failed");
  }
};

const fetchDynamicAPI = async (
  endpoint: string,
  params: Record<string, string | number | bigint>,
): Promise<BiliDynamicDetailResponse | null> => {
  try {
    const response = await dynamicDetailClient.get<BiliDynamicDetailResponse>(
      endpoint,
      {
        params,
      },
    );
    return response.data;
  } catch (error) {
    if (isAccountAuthError(error)) {
      throw error;
    }
    if (isHttpNotFound(error)) {
      return null;
    }

    logger.error("API Error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    throw new Error("API Error: Fetch dynamic detail failed");
  }
};

function isHttpNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === 404;
}

export const getNewDynamic = (
  type: number,
  uid: string = config.bilibili.uid ?? "",
  client?: AxiosInstance,
) => fetchDynamicsAPI("/dynamic_new", { uid, type }, client);

export const getHistoryDynamic = (
  type: number,
  offset: number | string | bigint,
  uid: string = config.bilibili.uid ?? "",
  client?: AxiosInstance,
) =>
  fetchDynamicsAPI(
    "/dynamic_history",
    { uid, type, offset_dynamic_id: offset },
    client,
  );

export const getDynamic = (dynamicId: number | string) =>
  fetchDynamicAPI("/get_dynamic_detail", {
    dynamic_id: dynamicId,
  });
