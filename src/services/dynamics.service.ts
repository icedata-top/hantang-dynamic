import { getDynamicFeed } from "../api/dynamic";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import type { BiliDynamicCard } from "../types";
import { sleep } from "../utils/datetime";
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
    let offset: string | undefined;
    const seenOffsets = new Set<string>();
    while (true) {
      const response = await getDynamicFeed(offset, this.account.dynamicClient);
      if (response.code !== 0) {
        throw new Error(`Dynamic feed API error: ${response.code}`);
      }
      const items = response.data.items ?? [];
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

      if (
        !response.data.has_more ||
        (items.length > 0 &&
          (items.every(
            (item) => Number(item.modules.module_author.pub_ts) <= minTimestamp,
          ) ||
            items.every((item) => BigInt(item.id_str) <= minDynamicId)))
      )
        return;
      const nextOffset = response.data.offset;
      if (!nextOffset || seenOffsets.has(nextOffset)) {
        throw new Error("Dynamic feed returned a missing or repeated cursor");
      }
      seenOffsets.add(nextOffset);
      offset = nextOffset;
    }
  }
}
