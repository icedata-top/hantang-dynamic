/**
 * Core video data model used throughout the application
 */
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
