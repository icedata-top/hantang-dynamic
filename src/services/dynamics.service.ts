import { isAccountAuthError } from "../api/client";
import { FEED_END_CODE, getDynamicFeed } from "../api/dynamic";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import type { BiliDynamicCard, BiliDynamicFeedResponse } from "../types";
import { sleep } from "../utils/datetime";
import { logger } from "../utils/logger";
import { toDynamicCard } from "./dynamicCard";

interface FetchDynamicsStreamOptions {
  minDynamicId: bigint;
  minTimestamp: number;
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

export class DynamicsService {
  constructor(private account: AccountContext) {}

  async *fetchDynamicsStream({
    minDynamicId,
    minTimestamp,
  }: FetchDynamicsStreamOptions): AsyncGenerator<{
    cards: BiliDynamicCard[];
    maxDynamicId: bigint;
  }> {
    const uid = this.account.uid || "unknown";
    let offset: string | undefined;
    let page = 0;
    const seenOffsets = new Set<string>();
    const requestPage = async (
      cursor: string | undefined,
      pageNumber: number,
    ): Promise<BiliDynamicFeedResponse> => {
      const response = await getDynamicFeed(
        cursor,
        this.account.dynamicClient,
        { page: pageNumber },
      );
      if (response.code !== 0) {
        // Clients without the shared interceptors return business error codes
        // instead of rejecting; normalize both shapes for the caller.
        throw Object.assign(
          new Error(`API Error: code ${response.code} ${response.message}`),
          { code: response.code, data: response },
        );
      }
      return response;
    };

    while (true) {
      page += 1;
      const cursor = offset ?? "<start>";
      let response: BiliDynamicFeedResponse;
      let retriedFeedEnd = false;
      while (true) {
        try {
          response = await requestPage(offset, page);
          break;
        } catch (error) {
          if (isAccountAuthError(error)) throw error;
          if (errorCode(error) === FEED_END_CODE) {
            if (!retriedFeedEnd) {
              retriedFeedEnd = true;
              logger.warn(
                `[uid=${uid}] Feed page ${page} returned ${FEED_END_CODE}; retrying once (offset=${cursor})`,
              );
              if (config.application.apiWaitTime > 0) {
                await sleep(config.application.apiWaitTime);
              }
              continue;
            }
            logger.warn(
              `[uid=${uid}] Feed ended after ${page - 1} page(s): page ${page} still returns ` +
                `${FEED_END_CODE} (offset=${cursor}); treating it as the end of the reachable feed.`,
            );
            return;
          }
          const reason = errorReason(error);
          logger.error(
            `[uid=${uid}] Dynamic feed request failed on page ${page} (offset=${cursor}): ${reason}`,
          );
          throw new Error(
            `Dynamic feed request failed on page ${page} (offset=${cursor}): ${reason}`,
          );
        }
      }
      const items = response.data.items ?? [];
      logger.info(
        `[uid=${uid}] Feed page ${page}: ${items.length} item(s), ` +
          `has_more=${response.data.has_more}`,
      );
      logger.debug(
        `[uid=${uid}] Feed page ${page} request offset=${cursor} ` +
          `next=${response.data.offset ?? "<none>"}`,
      );
      if (config.application.apiWaitTime > 0) {
        await sleep(config.application.apiWaitTime);
      }
      const cards: BiliDynamicCard[] = [];
      let maxDynamicId = minDynamicId;
      for (const item of items) {
        const id = BigInt(item.id_str);
        if (id > maxDynamicId) maxDynamicId = id;
        if (
          id <= minDynamicId ||
          Number(item.modules.module_author.pub_ts) <= minTimestamp
        )
          continue;
        const card = toDynamicCard(item);
        if (card) cards.push(card);
      }
      yield {
        cards: cards.sort((a, b) => a.desc.timestamp - b.desc.timestamp),
        maxDynamicId,
      };

      if (!response.data.has_more) {
        logger.info(
          `[uid=${uid}] Feed ended after page ${page}: has_more=false`,
        );
        return;
      }
      if (
        items.length > 0 &&
        (items.every(
          (item) => Number(item.modules.module_author.pub_ts) <= minTimestamp,
        ) ||
          items.every((item) => BigInt(item.id_str) <= minDynamicId))
      ) {
        logger.info(
          `[uid=${uid}] Feed ended after page ${page}: reached the requested history window`,
        );
        return;
      }
      const nextOffset = response.data.offset;
      if (!nextOffset || seenOffsets.has(nextOffset)) {
        throw new Error(
          `Dynamic feed returned a missing or repeated cursor after page ${page} (offset=${cursor})`,
        );
      }
      seenOffsets.add(nextOffset);
      offset = nextOffset;
    }
  }
}
