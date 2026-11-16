export interface VideoMinuteSample {
  aid: bigint;
  time: Date;
  coin?: number | null;
  favorite?: number | null;
  danmaku?: number | null;
  view?: number | null;
  reply?: number | null;
  share?: number | null;
  like?: number | null;
}

export interface PersistableVideoMinuteSample extends VideoMinuteSample {
  view: number;
}

export interface CompleteVideoMinuteTuple {
  aid: bigint;
  time: Date;
  coin: number;
  favorite: number;
  danmaku: number;
  view: number;
  reply: number;
  share: number;
  like: number;
}

export interface DailyCollectionCandidate {
  aid: bigint;
  latestDailyDelta: number | null;
  weeklyAvgDailyDelta: number | null;
  priority: number;
  lastDailyRecordDate: Date | null;
  lastView: number | null;
}
