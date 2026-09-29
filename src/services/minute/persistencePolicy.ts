import type { PersistableVideoMinuteSample } from "../../types/models/minute";

const HUNDRED_BUCKET_SIZE = 100;
const VIEW_DELTA_THRESHOLD = 50;
const COUNTER_CHANGE_INTERVAL_MS = 15 * 60 * 1000;

function hasAnyCounterChange(
  previous: PersistableVideoMinuteSample,
  sample: PersistableVideoMinuteSample,
): boolean {
  const counters = [
    "coin",
    "favorite",
    "danmaku",
    "view",
    "reply",
    "share",
    "like",
  ] as const;
  return counters.some((counter) => {
    const current = sample[counter];
    return (
      current !== undefined && current !== null && current !== previous[counter]
    );
  });
}

/** A sample without a prior stored tuple is the initial persisted tuple. */
export function shouldPersistMinuteSample(
  previous: PersistableVideoMinuteSample | null,
  sample: PersistableVideoMinuteSample,
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
