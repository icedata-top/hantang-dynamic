export type VideoCollectionTaskType = "minute" | "gate";

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

export interface VideoCollectionTask {
  id: bigint;
  aid: bigint;
  taskType: VideoCollectionTaskType;
  dedupeKey: string;
  dueAt: Date;
  lockedUntil: Date | null;
  attemptCount: number;
  gateValue: bigint | null;
  gateReason: string | null;
}

export interface DailyCollectionCandidate {
  aid: bigint;
  latestDailyDelta: number | null;
  weeklyAvgDailyDelta: number | null;
  priority: number;
  lastDailyRecordDate: Date | null;
  lastView: number | null;
}

export interface ProcessedVideoCollectionInput {
  aid: bigint;
  pubdate?: number | null;
  ctime?: number | null;
  tidV2?: number | null;
  labelContentType?: string | null;
  labelOrigin?: string | null;
  labeledBy?: string | null;
  isDeleted?: boolean | null;
  isFiltered?: boolean | null;
}
