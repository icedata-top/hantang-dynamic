/**
 * User profile information in dynamic cards
 */
export interface BiliUserProfile {
  info?: {
    aid: bigint;
    uname: string;
    face: string;
  };
  card?: Record<string, unknown>;
  vip: Record<string, unknown>;
  pendant: Record<string, unknown>;
  rank: number;
  sign: string;
  level_info: Record<string, unknown>;
}

/**
 * Relation status information
 */
export interface BiliRelation {
  status?: number;
  is_follow?: number;
  is_followed?: number;
}

/**
 * Display information for dynamic cards
 */
export interface BiliDisplay {
  origin?: string | null;
  usr_action_txt?: string;
  relation?: BiliRelation;
  live_info?: string | null;
  emoji_info?: string | null;
  highlight?: string | null;
}

/**
 * Origin dynamic information (for forwarded dynamics)
 */
export interface BiliOriginDynamic {
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
  origin?: Record<string, unknown>;
  bvid: string | null;
  previous?: null;
}

/**
 * Dynamic card description containing metadata
 */
export interface BiliDynamicDesc {
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
  user_profile?: BiliUserProfile;
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
  origin?: BiliOriginDynamic;
  bvid: string;
}

/**
 * Main dynamic card structure
 */
export interface BiliDynamicCard {
  desc: BiliDynamicDesc;
  card: string;
  extend_json?: string;
  display?: BiliDisplay;
}
