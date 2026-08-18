export interface BiliToViewStat {
  aid: number;
  coin: number;
  favorite: number;
  danmaku: number;
  view: number;
  reply: number;
  share: number;
  like: number;
}

export interface BiliToViewItem {
  aid: number;
  stat: BiliToViewStat;
}

export interface BiliToViewWebData {
  count: number;
  list: BiliToViewItem[];
}

export interface BiliToViewWebResponse {
  code: number;
  message?: string;
  ttl?: number;
  data?: BiliToViewWebData;
}
