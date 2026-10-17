import type { BiliDynamicItem } from "../bilibili/dynamic";

export interface BiliDynamicFeedResponse {
  code: number;
  message: string;
  data: {
    items?: BiliDynamicItem[];
    offset: string;
    has_more: boolean;
    update_num?: number;
  };
}
