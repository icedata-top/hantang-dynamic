import type {
  CompleteVideoMinuteTuple,
  VideoMinuteSample,
} from "../../types/models/minute";

export function isMinuteCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
  );
}

export function isCompleteVideoMinuteSample(
  sample: VideoMinuteSample,
): sample is CompleteVideoMinuteTuple {
  return (
    sample.aid > 0n &&
    isMinuteCounter(sample.coin) &&
    isMinuteCounter(sample.favorite) &&
    isMinuteCounter(sample.danmaku) &&
    isMinuteCounter(sample.view) &&
    isMinuteCounter(sample.reply) &&
    isMinuteCounter(sample.share) &&
    isMinuteCounter(sample.like)
  );
}
