/**
 * Video dimension information
 */
export interface BiliVideoDimension {
  width: number;
  height: number;
  rotate: number;
}

/**
 * Video owner information
 */
export interface BiliVideoOwner {
  mid: bigint;
  name: string;
  face: string;
}

/**
 * Video statistics
 */
export interface BiliVideoStat {
  aid: number;
  view: number;
  danmaku: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
  like: number;
  dislike: number;
  now_rank: number;
  his_rank: number;
  evaluation?: string;
  vt?: number;
}

/**
 * Video rights and permissions
 */
export interface BiliVideoRights {
  bp: number;
  elec: number;
  download: number;
  movie: number;
  pay: number;
  hd5: number;
  no_reprint: number;
  autoplay: number;
  ugc_pay: number;
  is_cooperation: number;
  ugc_pay_preview: number;
  no_background: number;
  clean_mode: number;
  is_stein_gate: number;
  is_360: number;
  no_share: number;
  arc_pay: number;
  free_watch: number;
}

/**
 * Video page information
 */
export interface BiliVideoPage {
  cid: number;
  page: number;
  from: string;
  part: string;
  duration: number;
  vid: string;
  weblink: string;
  dimension: BiliVideoDimension;
  first_frame?: string;
}

/**
 * Video card structure (content of dynamic.card when parsed)
 */
export interface BiliVideoCard {
  aid: bigint;
  cid: number;
  ctime: number;
  desc: string;
  dimension?: BiliVideoDimension;
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

/**
 * Forward card user information
 */
export interface BiliForwardUser {
  aid: bigint;
  uname: string;
  face: string;
}

/**
 * Forward card item information
 */
export interface BiliForwardItem {
  rp_id: number;
  aid: bigint;
  content: string;
  reply: number;
  orig_type: number;
  orig_dy_id: bigint;
  pre_dy_id: bigint;
}

/**
 * Forward card origin user information
 */
export interface BiliForwardOriginUser {
  info: {
    aid: bigint;
    uname: string;
    face: string;
  };
  card: Record<string, unknown>;
  vip: Record<string, unknown>;
  pendant: Record<string, unknown>;
  rank: number;
  sign: string;
  level_info: Record<string, unknown>;
}

/**
 * Forward card structure
 */
export interface BiliForwardCard {
  user: BiliForwardUser;
  item: BiliForwardItem;
  origin: string;
  origin_extend_json: string;
  origin_user: BiliForwardOriginUser;
}

/**
 * Recommended video from related list
 */
export interface RecommendedVideo {
  aid: number;
  bvid: string;
  cid: number;
  title: string;
  pic: string;
  owner: {
    mid: number;
    name: string;
    face: string;
  };
  stat: {
    aid: number;
    view: number;
    danmaku: number;
    reply: number;
    favorite: number;
    coin: number;
    share: number;
    like: number;
  };
  pubdate: number;
  duration: number;
  desc: string;
  tid: number;
  tname: string;
}

/**
 * Full video detail response including related videos
 */
export interface BiliVideoFullDetailResponse {
  code: number;
  message: string;
  ttl: number;
  data: {
    View: {
      aid: bigint;
      bvid: string;
      cid: number;
      copyright: number;
      ctime: number;
      desc: string;
      dimension: BiliVideoDimension;
      duration: number;
      dynamic: string;
      owner: BiliVideoOwner;
      pic: string;
      pubdate: number;
      rights: BiliVideoRights;
      stat: BiliVideoStat;
      state: number;
      tid: number;
      title: string;
      tname: string;
      videos: number;
    };
    Card: {
      card: {
        mid: string;
        name: string;
        face: string;
        fans: number;
        attention: number;
        sign: string;
        level_info: {
          current_level: number;
        };
      };
      following: boolean;
      archive_count: number;
      article_count: number;
      follower: number;
    };
    Tags: Array<{
      tag_id: number;
      tag_name: string;
      cover: string;
      likes: number;
      hates: number;
      attribute: number;
      is_activity: number;
      uri: string;
      tag_type: string;
    }>;
    Reply: {
      page: {
        num: number;
        size: number;
        count: number;
      };
      replies: Array<unknown>;
    };
    Related: RecommendedVideo[];
  };
}
