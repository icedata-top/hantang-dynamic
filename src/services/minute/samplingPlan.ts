import type { VideoMinuteSample } from "../../types/models/minute";

export function planFavoriteFallbackBatches(
  requestedAids: bigint[],
  toViewSamples: VideoMinuteSample[],
  batchSize: number,
): bigint[][] {
  const coveredAids = new Set(
    toViewSamples.map((sample) => sample.aid.toString()),
  );
  const missingAids = requestedAids.filter(
    (aid) => !coveredAids.has(aid.toString()),
  );
  const batches: bigint[][] = [];

  for (let index = 0; index < missingAids.length; index += batchSize) {
    batches.push(missingAids.slice(index, index + batchSize));
  }

  return batches;
}
