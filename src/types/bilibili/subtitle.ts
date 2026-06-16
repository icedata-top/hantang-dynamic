export interface BiliSubtitleLine {
  from: number;
  to: number;
  sid: number;
  location: number;
  content: string;
}

export interface BiliSubtitleStyle {
  font_size?: number;
  font_color?: string;
  background_alpha?: number;
  background_color?: string;
  Stroke?: string;
}

export interface BiliSubtitleJson extends BiliSubtitleStyle {
  body: BiliSubtitleLine[];
}

export interface BiliSubtitleTrackInfo {
  id: number;
  lan: string;
  lan_doc: string;
  subtitle_url: string;
  type: number;
  ai_type: number;
  ai_status: number;
}

export interface BiliPlayerSubtitleResponse {
  allow_submit: boolean;
  subtitles: BiliSubtitleTrackInfo[];
}

export interface BiliPlayerWbiV2Response {
  code: number;
  message: string;
  ttl: number;
  data?: {
    subtitle?: BiliPlayerSubtitleResponse;
  };
}

export type SubtitleState =
  | "pending"
  | "has_manual"
  | "partial_manual"
  | "ai_only"
  | "no_subtitle"
  | "skipped";

export interface VideoSubtitleRow {
  aid: bigint;
  cid: bigint;
  lan: string;
  lanDoc: string | null;
  subtitleType: number | null;
  aiType: number | null;
  aiStatus: number | null;
  body: BiliSubtitleLine[];
  plainText: string | null;
  lineCount: number | null;
  style: BiliSubtitleStyle | null;
  fetchedAt: Date;
  updatedAt: Date;
}

export function isManualSubtitle(track: BiliSubtitleTrackInfo): boolean {
  return track.type === 0;
}

export function isAiSubtitle(track: BiliSubtitleTrackInfo): boolean {
  return track.type === 1;
}
