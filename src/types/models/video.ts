/**
 * Core video data model used throughout the application
 */
export interface VideoData {
  // === Core identifiers ===
  aid: bigint;
  bvid: string;

  // === User info ===
  user_id: bigint;
  staff?: bigint[]; // 联合投稿成员 mid 列表

  // === Category ===
  type_id: number; // tid
  tid_v2?: number;

  // === Content ===
  title: string;
  description: string; // desc
  dynamic?: string; // 动态文字内容
  pic: string;
  tag: string; // 保留分号分隔
  tag_new?: string[];
  participle?: string[]; // 分词

  // === Timing ===
  pubdate: number;
  ctime?: number;

  // === Flags ===
  is_deleted?: boolean;
  copyright?: number;

  // === Extras (misc metadata) ===
  extras?: VideoExtras;

  // === Manual review ===
  notes?: VideoNotes;
}

/**
 * Extras container for miscellaneous video metadata
 */
interface VideoExtras {
  duration?: number;
  videos?: number; // 分P数
  state?: number; // 视频状态
  cid?: number; // 1P cid
  mission_id?: number;
  ugc_season_id?: number; // 合集 id
  dimension?: { width: number; height: number; rotate: number };
  rights?: {
    bp?: number;
    elec?: number;
    download?: number;
    movie?: number;
    pay?: number;
    hd5?: number;
    no_reprint?: number;
    autoplay?: number;
    ugc_pay?: number;
    is_cooperation?: number;
    ugc_pay_preview?: number;
    no_background?: number;
    clean_mode?: number;
    is_stein_gate?: number;
    is_360?: number;
    no_share?: number;
    arc_pay?: number;
    free_watch?: number;
  };
  argue_info?: { argue_msg: string; argue_type: number; argue_link: string };
  honor_reply?: {
    honor?: Array<{
      type: number;
      desc: string;
      weekly_recommend_num: number;
    }>;
  };
}

/**
 * Manual review notes
 */
interface VideoNotes {
  check_status?: "unqualified" | "pending" | "checked";
  video_category?: "non_vocaloid" | "chinese_v" | "japanese_v" | string;
  custom_tags?: string[];
  api_code?: number;
  api_message?: string;
}

/**
 * Video tag information
 */
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
