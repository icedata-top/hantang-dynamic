import type {
  BiliVideoDimension,
  BiliVideoOwner,
  BiliVideoPage,
  BiliVideoRights,
  BiliVideoStat,
} from "../bilibili/video";
import type { VideoTag } from "../models/video";

/**
 * Video description information (desc_v2 array item)
 */
export interface BiliVideoDescItem {
  raw_text: string;
  type: number;
  biz_id: number;
}

/**
 * Video subtitle information
 */
export interface BiliVideoSubtitle {
  allow_submit: boolean;
  list: unknown[];
}

/**
 * User garb information
 */
export interface BiliUserGarb {
  url_image_ani_cut: string;
}

/**
 * Honor reply information
 */
export interface BiliHonorReply {
  honor: unknown[];
}

/**
 * Argue information for controversial content
 */
export interface BiliArgueInfo {
  argue_msg: string;
  argue_link: string;
  argue_type: number;
}

/**
 * Response structure for video detail endpoint
 */
export interface BiliVideoDetailResponse {
  code: number;
  message: string;
  ttl: number;
  data: {
    bvid: string;
    aid: number;
    videos: number;
    tid: number;
    tname: string;
    copyright: number;
    pic: string;
    title: string;
    pubdate: number;
    ctime: number;
    desc: string;
    desc_v2?: BiliVideoDescItem[];
    state: number;
    duration: number;
    rights: BiliVideoRights;
    owner: BiliVideoOwner;
    stat: BiliVideoStat;
    dynamic: string;
    cid: number;
    dimension: BiliVideoDimension;
    pages: BiliVideoPage[];
    subtitle?: BiliVideoSubtitle;
    staff?: unknown[];
    user_garb?: BiliUserGarb;
    honor_reply?: BiliHonorReply;
    like_icon?: string;
    need_jump_bv?: boolean;
    disable_show_up_info?: boolean;
    is_story_play?: boolean;
    argue_info?: BiliArgueInfo;
  };
}

/**
 * Response structure for video description endpoint
 */
export interface BiliVideoDescResponse {
  code: number;
  message: string;
  ttl: number;
  data: string;
}

/**
 * Response structure for video page list endpoint
 */
export interface BiliVideoPageListResponse {
  code: number;
  message: string;
  ttl: number;
  data: BiliVideoPage[];
}

/**
 * Response structure for video tags endpoint
 */
export interface VideoTagResponse {
  code: number;
  message: string;
  ttl: number;
  data: VideoTag[];
}
