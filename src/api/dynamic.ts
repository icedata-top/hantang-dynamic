import { dynamicClient } from "./client";
import {
  BiliDynamicNewResponse,
  BiliDynamicHistoryResponse,
  BiliDynamicDetailResponse,
  BiliDynamicCard,
} from "../core/types";
import { config } from "../core/config";
import { sleep } from "../utils/datetime";

type DynamicType = "video" | "forward";

const DYNAMIC_TYPE_MAP: Record<DynamicType, number> = {
  forward: 1,
  video: 8,
};

export const fetchDynamicsAPI = async (
  endpoint: string,
  params: Record<string, any>,
): Promise<BiliDynamicNewResponse | BiliDynamicHistoryResponse> => {
  try {
    const response = await dynamicClient.get<
      BiliDynamicNewResponse | BiliDynamicHistoryResponse
    >(endpoint, {
      params,
    });
    return response.data;
  } catch (error) {
    console.error("API Error:", error);
    throw new Error("API Error: Fetch dynamics failed");
  }
};

export const fetchDynamicAPI = async (
  endpoint: string,
  params: Record<string, any>,
): Promise<BiliDynamicDetailResponse> => {
  try {
    const response = await dynamicClient.get<BiliDynamicDetailResponse>(
      endpoint,
      {
        params,
      },
    );
    return response.data;
  } catch (error) {
    console.error("API Error:", error);
    throw new Error("API Error: Fetch dynamic detail failed");
  }
};

export const getNewDynamic = (type: number) =>
  fetchDynamicsAPI("/dynamic_new", {
    uid: config.BILIBILI_UID,
    type,
  });

export const getHistoryDynamic = (type: number, offset: number | string) =>
  fetchDynamicsAPI("/dynamic_history", {
    uid: config.BILIBILI_UID,
    type,
    offset_dynamic_id: offset,
  });

export const getDynamic = (dynamicId: number | string) =>
  fetchDynamicAPI("/get_dynamic_detail", {
    dynamic_id: dynamicId,
  });

export const fetchDynamics = async ({
  minDynamicId = 0 as number,
  minTimestamp = (Date.now() / 1000 -
    config.MAX_HISTORY_DAYS * 86400) as number,
  max_items = 0 as number,
  types = ["video", "forward"] as DynamicType[],
}): Promise<BiliDynamicCard[]> => {
  const dynamics: BiliDynamicCard[] = [];
  let apiNo = 0;
  let totalItems = 0;

  for (const type of types) {
    const typeCode = DYNAMIC_TYPE_MAP[type];
    let offset = minDynamicId;
    let hasMore = true;
    let firstRun = minDynamicId === 0;

    while (hasMore) {
      let response: BiliDynamicNewResponse | BiliDynamicHistoryResponse;

      response = firstRun
        ? await getNewDynamic(typeCode)
        : await getHistoryDynamic(typeCode, offset);

      if (response.code !== 0 || !response.data.cards?.length) {
        console.error(`API Error for ${type}:`, response);
        break;
      }

      const validCards = response.data.cards.filter((card) => {
        const isTimestampValid = card.desc.timestamp > minTimestamp;
        const isDynamicIdValid = card.desc.dynamic_id > minDynamicId;
        return isTimestampValid && isDynamicIdValid;
      });

      dynamics.push(...validCards);
      totalItems += validCards.length;

      if (
        !validCards.length ||
        validCards.length < response.data.cards.length ||
        (totalItems >= max_items && max_items > 0)
      )
        break;

      if (firstRun) {
        const newResponse = response as BiliDynamicNewResponse;
        offset = newResponse.data.history_offset;
        firstRun = false;
      } else {
        const historyResponse = response as BiliDynamicHistoryResponse;
        hasMore = historyResponse.data.has_more === 1;
        offset = historyResponse.data.next_offset;
      }

      if (config.API_WAIT_TIME > 0) {
        await sleep(config.API_WAIT_TIME);
      }
    }
  }

  if (max_items > 0) {
    dynamics.splice(max_items);
  }

  console.log(`Total ${dynamics.length} dynamics fetched`);
  return dynamics.sort((a, b) => a.desc.timestamp - b.desc.timestamp);
};
