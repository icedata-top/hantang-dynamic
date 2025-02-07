import { dynamicClient } from "./client";
import {
  BiliDynamicNewResponse,
  BiliDynamicHistoryResponse,
  BiliCard,
} from "../core/types";
import { config } from "../core/config";
import { sleep } from "../utils/datetime";

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

export const getNewDynamics = () =>
  fetchDynamicsAPI("/dynamic_new", { uid: config.UID, type: 8 });
export const getHistoryDynamics = (offset: number) =>
  fetchDynamicsAPI("/dynamic_history", {
    uid: config.UID,
    type: 8,
    offset_dynamic_id: offset,
  });

export const fetchDynamics = async ({
  minDynamicId = 0 as number,
  minTimestamp = (Date.now() / 1000 -
    config.MAX_HISTORY_DAYS * 86400) as number,
}): Promise<BiliCard[]> => {
  const dynamics: BiliCard[] = [];
  let offset = minDynamicId;
  let hasMore = true;
  let firstRun = minDynamicId === 0;
  let apiNo = 0;

  while (hasMore) {
    let response: BiliDynamicNewResponse | BiliDynamicHistoryResponse;

    response = firstRun
      ? await getNewDynamics()
      : await getHistoryDynamics(offset);

    if (response.code !== 0 || !response.data.cards?.length) {
      console.error("API Error:", response);
      break;
    }

    const validCards = response.data.cards.filter((card) => {
      const isTimestampValid = card.desc.timestamp > minTimestamp;
      const isDynamicIdValid = card.desc.dynamic_id > minDynamicId;
      return isTimestampValid && isDynamicIdValid;
    });

    console.log(`API ${++apiNo}: ${validCards.length} new dynamics at time ${new Date().toLocaleString()}`);

    dynamics.push(...validCards);

    if (!validCards.length || validCards.length < response.data.cards.length)
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
  console.log(`Total ${dynamics.length} dynamics fetched`);
  return dynamics.reverse();
};
