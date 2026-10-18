import { getDynamicFeed } from "../api/dynamic";
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
    while (true) {
      page += 1;
      const cursor = offset ?? "<start>";
      let response: BiliDynamicFeedResponse;
      try {
        response = await getDynamicFeed(offset, this.account.dynamicClient, {
          page,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(
          `[uid=${uid}] Dynamic feed request failed on page ${page} (offset=${cursor}): ${reason}`,
        );
        throw new Error(
          `Dynamic feed request failed on page ${page} (offset=${cursor}): ${reason}`,
        );
      }
      if (response.code !== 0) {
        logger.error(
          `[uid=${uid}] Dynamic feed API error on page ${page} (offset=${cursor}): ` +
            `code=${response.code} message=${response.message}`,
        );
        throw new Error(
          `Dynamic feed API error on page ${page} (offset=${cursor}): ` +
            `${response.code} ${response.message}`,
        );
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
