export interface BiliCard {
  desc: {
    BILIBILI_UID: number;
    dynamic_id: number;
    timestamp: number;
    bvid: string;
    type: number;
    rid: number;
    view?: number;
    like?: number;
    comment?: number;
  };
  card: string;
  extend_json?: string;
  display?: {
    usr_action_txt?: string;
  };
}

// /dynamic_new 响应结构
export interface BiliDynamicNewResponse {
  code: number;
  msg: string;
  data: {
    exist_gap: number; // 是否存在动态缺口
    new_num: number; // 新动态数量
    update_num: number; // 更新动态数量
    history_offset: number; // 历史动态偏移量
    max_dynamic_id: number; // 最大动态ID
    cards: BiliCard[]; // 动态卡片列表
  };
}

// /dynamic_history 响应结构
export interface BiliDynamicHistoryResponse {
  code: number;
  msg: string;
  data: {
    has_more: number; // 是否还有更多数据
    next_offset: number; // 下一次请求的偏移量
    cards: BiliCard[]; // 动态卡片列表
  };
}

export interface VideoTagResponse {
  code: number;
  message: string;
  ttl: number;
  data: VideoTag[];
}

export interface VideoTag {
  tag_id: number;
  tag_name: string;
  cover: string;
  head_cover: string;
  content: string;
  short_content: string;
  type: number;
  state: number;
  ctime: number;
  count: {
    view: number;
    use: number;
    atten: number;
  };
  is_atten: number;
  likes: number;
  hates: number;
  attribute: number;
  liked: number;
  hated: number;
}

export interface VideoData {
  aid: number;
  bvid: string;
  pubdate: number;
  title: string;
  description: string;
  tag: string;
  pic: string;
  type_id: number;
  user_id: number;
}
