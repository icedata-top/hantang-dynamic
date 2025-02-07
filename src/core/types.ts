// 动态的card结构
export interface BiliDynamicCard {
  desc: {
    uid: number;
    type: number;
    rid: number;
    acl: number;
    view: number;
    repost: number;
    like: number;
    is_liked: number;
    dynamic_id: number;
    timestamp: number;
    pre_dy_id?: number;
    orig_dy_id?: number;
    orig_type?: number;
    user_profile?: {
      info?: {
        uid: number;
        uname: string;
        face: string;
      };
      card?: {};
      vip: {};
      pendant: {};
      rank: number;
      sign: string;
      level_info: {};
    };
    spec_type: number;
    uid_type: number;
    stype: number;
    r_type: number;
    inner_id: number;
    status: number;
    dynamic_id_str: string;
    pre_dy_id_str?: string;
    bvid: string;
    comment?: number;
  };
  card: string;
  extend_json?: string;
  display?: {
    origin?: string | null;
    usr_action_txt?: string;
    relation?: {
      status?: number;
      is_follow?: number;
      is_followed?: number;
    };
    live_info?: string | null;
    emoji_info?: string | null;
    highlight?: string | null;
  };
}

// 视频的card结构
export interface BiliCards {
  aid: number;
  cid: number;
  ctime: number;
  desc: string;
  dimension?: {
    height: number;
    rotate: number;
    width: number;
  };
  duration: number;
  dynamic?: string;
  first_frame: string;
  jump_url: string;
  owner: {
    face: string;
    mid: number;
    name: string;
  };
  pic: string;
  pubdate: number;
  short_link: string | null;
  stat: {
    aid: number;
    coin: number;
    danmaku: number;
    dislike: number;
    favorite: number;
    like: number;
    reply: number;
    share: number;
    view: number;
  };
  state: number;
  tid: number;
  title: string;
  tname: string;
  videos: number;
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
    cards: BiliDynamicCard[]; // 动态卡片列表
  };
}

// /dynamic_history 响应结构
export interface BiliDynamicHistoryResponse {
  code: number;
  msg: string;
  data: {
    has_more: number; // 是否还有更多数据
    next_offset: number; // 下一次请求的偏移量
    cards: BiliDynamicCard[]; // 动态卡片列表
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
