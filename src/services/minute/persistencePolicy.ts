import type { CompleteVideoMinuteTuple } from "../../types/models/minute";

const HUNDRED_BUCKET_SIZE = 100;
const VIEW_DELTA_THRESHOLD = 50;
const COUNTER_CHANGE_INTERVAL_MS = 15 * 60 * 1000;

function hasAnyCounterChange(
  previous: CompleteVideoMinuteTuple,
  sample: CompleteVideoMinuteTuple,
): boolean {
  return (
    sample.coin !== previous.coin ||
    sample.favorite !== previous.favorite ||
    sample.danmaku !== previous.danmaku ||
    sample.view !== previous.view ||
    sample.reply !== previous.reply ||
    sample.share !== previous.share ||
    sample.like !== previous.like
  );
}

/** A sample without a prior complete tuple is the initial persisted tuple. */
export function shouldPersistMinuteSample(
  previous: CompleteVideoMinuteTuple | null,
  sample: CompleteVideoMinuteTuple,
): boolean {
  if (previous === null) return true;

  const currentBucket = Math.floor(sample.view / HUNDRED_BUCKET_SIZE);
  const previousBucket = Math.floor(previous.view / HUNDRED_BUCKET_SIZE);
  if (currentBucket !== previousBucket) return true;

  if (sample.view - previous.view > VIEW_DELTA_THRESHOLD) return true;

  return (
    sample.time.getTime() - previous.time.getTime() >=
      COUNTER_CHANGE_INTERVAL_MS && hasAnyCounterChange(previous, sample)
  );
}
