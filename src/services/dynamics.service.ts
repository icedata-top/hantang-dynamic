import { getHistoryDynamic, getNewDynamic } from "../api/dynamic";
import { config } from "../config";
import { StateManager } from "../core/state";
import type {
  BiliDynamicCard,
  BiliDynamicHistoryResponse,
  BiliDynamicNewResponse,
} from "../types";
import { sleep } from "../utils/datetime";
import { logger } from "../utils/logger";

type DynamicType = "video" | "forward";

const DYNAMIC_TYPE_MAP: Record<DynamicType, number> = {
  forward: 1,
  video: 8,
};

export interface FetchDynamicsStreamOptions {
  minDynamicId: bigint;
  minTimestamp: number;
  types: DynamicType[];
}

/**
 * DynamicsService - 流式动态抓取服务
 *
 * 职责：
 * - 从Bilibili API获取动态数据
 * - 以流式方式返回，每获取一页立即yield
 * - 支持按时间戳和动态ID过滤
 * - 支持多种动态类型（视频、转发）
 */
export class DynamicsService {
  /**
   * 流式获取动态数据
   *
   * @param options - 获取选项
   * @yields 每一页的动态数据
   */
  async *fetchDynamicsStream(
    options: FetchDynamicsStreamOptions,
  ): AsyncGenerator<BiliDynamicCard[], void, unknown> {
    const { minDynamicId, minTimestamp, types } = options;
    const stateManager = new StateManager();

    for (const type of types) {
      logger.info(`Fetching dynamics of type: ${type}`);
      const typeCode = DYNAMIC_TYPE_MAP[type];

      let offset = BigInt(0);
      let hasMore = true;
      let firstRun = true;

      while (hasMore) {
        try {
          // 获取一页数据
          const response: BiliDynamicNewResponse | BiliDynamicHistoryResponse =
            firstRun
              ? await getNewDynamic(typeCode)
              : await getHistoryDynamic(typeCode, offset);

          // 检查响应状态
          if (response.code !== 0 || !response.data.cards?.length) {
            logger.error(`API Error for ${type}:`, response);
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
            // 按时间戳排序后yield
            yield validCards.sort(
              (a, b) => a.desc.timestamp - b.desc.timestamp,
            );
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

            stateManager.updateLastDynamicId(
              newResponse.data.cards[0].desc.dynamic_id,
            );

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
          logger.error(`Error fetching ${type} dynamics:`, error);
          // 遇到错误时停止当前类型的抓取
          break;
        }
      }

      logger.info(`Completed fetching dynamics of type: ${type}`);
    }
  }
}
