import type { BiliDynamicCard } from "../bilibili/dynamic";

/**
 * Response structure for /dynamic_new endpoint
 */
export interface BiliDynamicNewResponse {
  code: number;
  msg: string;
  data: {
    exist_gap: number; // 是否存在动态缺口
    new_num: number; // 新动态数量
    update_num: number; // 更新动态数量
    history_offset: bigint; // 历史动态偏移量
    max_dynamic_id: bigint; // 最大动态ID
    cards: BiliDynamicCard[]; // 动态卡片列表
  };
}

/**
 * Response structure for /dynamic_history endpoint
 */
export interface BiliDynamicHistoryResponse {
  code: number;
  msg: string;
  data: {
    has_more: number; // 是否还有更多数据
    next_offset: bigint; // 下一次请求的偏移量
    cards: BiliDynamicCard[]; // 动态卡片列表
  };
}

/**
 * Response structure for /dynamic_detail endpoint
 */
export interface BiliDynamicDetailResponse {
  code: number;
  msg: string;
  data: {
    card: BiliDynamicCard;
  };
}
