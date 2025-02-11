// 动态的card结构
export interface BiliDynamicCard {
  desc: {
    uid: bigint;
    type: number;
    rid: bigint;
    acl: number;
    view: number;
    repost: number;
    comment: number;
    like: number;
    is_liked: number;
    dynamic_id: bigint;
    timestamp: number;
    pre_dy_id: bigint; // 原动态ID, 无则为0
    orig_dy_id: bigint; // 转发动态ID, 无则为0
    orig_type: bigint; // 原动态类型, 无则为0
    user_profile?: {
      info?: {
        aid: bigint;
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
    inner_id: bigint;
    status: number;
    dynamic_id_str: string;
    pre_dy_id_str?: string;
    orig_dy_id_str?: string;
    rid_str: string;
    origin?: {
      uid: bigint;
      type: number;
      rid: number;
      acl: number;
      view: number;
      repost: number;
      comment: number;
      like: number;
      is_liked: number;
      dynamic_id: bigint;
      timestamp: number;
      pre_dy_id?: number;
      orig_dy_id?: number;
      orig_type?: number;
      user_profile?: null;
      spec_type: number;
      uid_type: number;
      stype: number;
      r_type: number;
      inner_id: bigint;
      status: number;
      dynamic_id_str: string;
      pre_dy_id_str?: string;
      orig_dy_id_str?: string;
      rid_str: string;
      origin?: {};
      bvid: string | null;
      previous?: null;
    };
    bvid: string;
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
export interface BiliVideoCard {
  aid: bigint;
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
    mid: bigint;
    name: string;
  };
  pic: string;
  pubdate: number;
  short_link: string | null;
  stat: {
    aid: bigint;
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

// 转发的card结构
export interface BiliForwardCard {
  user: {
    aid: bigint;
    uname: string;
    face: string;
  };
  item: {
    rp_id: number;
    aid: bigint;
    content: string;
    reply: number;
    orig_type: number;
    orig_dy_id: bigint;
    pre_dy_id: bigint;
  };
  origin: string;
  origin_extend_json: string;
  origin_user: {
    info: {
      aid: bigint;
      uname: string;
      face: string;
    };
    card: {};
    vip: {};
    pendant: {};
    rank: number;
    sign: string;
    level_info: {};
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
    history_offset: bigint; // 历史动态偏移量
    max_dynamic_id: bigint; // 最大动态ID
    cards: BiliDynamicCard[]; // 动态卡片列表
  };
}

// /dynamic_history 响应结构
export interface BiliDynamicHistoryResponse {
  code: number;
  msg: string;
  data: {
    has_more: number; // 是否还有更多数据
    next_offset: bigint; // 下一次请求的偏移量
    cards: BiliDynamicCard[]; // 动态卡片列表
  };
}

// /dynamic_detail 响应结构
export interface BiliDynamicDetailResponse {
  code: number;
  msg: string;
  data: {
    card: BiliDynamicCard;
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
  aid: bigint;
  bvid: string;
  pubdate: number;
  title: string;
  description: string;
  tag: string;
  pic: string;
  type_id: number;
  user_id: bigint;
}
