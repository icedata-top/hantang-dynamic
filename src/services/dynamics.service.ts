import { getHistoryDynamic, getNewDynamic } from "../api/dynamic";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import type {
  BiliDynamicCard,
  BiliDynamicHistoryResponse,
  BiliDynamicNewResponse,
} from "../types";
import { sleep } from "../utils/datetime";
import { logger } from "../utils/logger";

export const KNOWN_DYNAMIC_TYPES = {
  FORWARD: 1,
  IMAGE: 2,
  TEXT: 4,
  VIDEO: 8,
  SHORT_VIDEO: 16,
  ARTICLE: 64,
} as const;

interface FetchDynamicsStreamOptions {
  minDynamicIdByType: Partial<Record<number, bigint>>;
  minTimestamp: number;
  types: number[];
}

/**
 * DynamicsService - 流式动态抓取服务
 *
 * 职责：
 * - 从Bilibili API获取动态数据
 * - 以流式方式返回，每获取一页立即yield
 * - 支持按时间戳和动态ID过滤
 * - 支持多种动态类型（视频、转发等）
 */
export class DynamicsService {
  private account: AccountContext;

  constructor(account: AccountContext) {
    this.account = account;
  }

  /**
   * 流式获取动态数据
   *
   * @param options - 获取选项
   * @yields 每一页的动态数据，附带类型码
   */
  async *fetchDynamicsStream(
    options: FetchDynamicsStreamOptions,
  ): AsyncGenerator<
    { typeCode: number; cards: BiliDynamicCard[] },
    void,
    unknown
  > {
    const { minDynamicIdByType, minTimestamp, types } = options;
    const uid = this.account.uid;
    const client = this.account.dynamicClient;

    for (const typeCode of types) {
      logger.info(`[uid=${uid}] Fetching dynamics of type: ${typeCode}`);
      const minDynamicId = minDynamicIdByType[typeCode] ?? BigInt(0);

      let offset = BigInt(0);
      let hasMore = true;
      let firstRun = true;

      while (hasMore) {
        try {
          // 获取一页数据
          const response: BiliDynamicNewResponse | BiliDynamicHistoryResponse =
            firstRun
              ? await getNewDynamic(typeCode, uid, client)
              : await getHistoryDynamic(typeCode, offset, uid, client);

          // 检查响应状态
          if (response.code !== 0 || !response.data.cards?.length) {
            logger.error(`API Error for type ${typeCode}:`, response);
            break;
          }

          // 过滤有效卡片
          const validCards = response.data.cards.filter((card) => {
            const isTimestampValid = card.desc.timestamp > minTimestamp;
            const isDynamicIdValid = card.desc.dynamic_id > minDynamicId;
            return isTimestampValid && isDynamicIdValid;
          });

          // 如果有有效数据，yield这一页
          if (validCards.length > 0) {
            yield {
              typeCode,
              cards: validCards.sort(
                (a, b) => a.desc.timestamp - b.desc.timestamp,
              ),
            };
          }

          // 判断是否继续
          if (
            !validCards.length ||
            validCards.length < response.data.cards.length
          ) {
            // 所有卡片都被过滤掉，或者部分被过滤，说明已经到达时间/ID边界
            break;
          }

          // 更新分页信息
          if (firstRun) {
            const newResponse = response as BiliDynamicNewResponse;
            offset = newResponse.data.history_offset;
            firstRun = false;
          } else {
            const historyResponse = response as BiliDynamicHistoryResponse;
            hasMore = historyResponse.data.has_more === 1;
            offset = historyResponse.data.next_offset;
          }

          // API限流等待
          if (config.application.apiWaitTime > 0) {
            await sleep(config.application.apiWaitTime);
          }
        } catch (error) {
          logger.error(`Error fetching type ${typeCode} dynamics:`, error);
          // 遇到错误时停止当前类型的抓取
          break;
        }
      }

      logger.info(
        `[uid=${uid}] Completed fetching dynamics of type: ${typeCode}`,
      );
    }
  }
}
