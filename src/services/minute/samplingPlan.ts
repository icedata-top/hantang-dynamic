import type { VideoMinuteSample } from "../../types/models/minute";
import { isCompleteVideoMinuteSample } from "./completeSample";

export interface MinuteSamplingCoverage {
  toViewSamples: VideoMinuteSample[];
  favoriteFallbackAids: bigint[];
}

function uniqueRequestedAids(requestedAids: readonly bigint[]): bigint[] {
  const uniqueAids: bigint[] = [];
  const seenAids = new Set<string>();
  for (const aid of requestedAids) {
    const key = aid.toString();
    if (seenAids.has(key)) continue;
    seenAids.add(key);
    uniqueAids.push(aid);
  }
  return uniqueAids;
}

/**
 * Partition a due set by verified current-snapshot coverage. Every requested
 * AID is represented once, either by a complete To View tuple or old-path
 * favorite fallback dispatch.
 */
export function partitionMinuteSamplingCoverage(
  requestedAids: readonly bigint[],
  toViewSamples: readonly VideoMinuteSample[],
): MinuteSamplingCoverage {
  const uniqueAids = uniqueRequestedAids(requestedAids);
  const requestedAidKeys = new Set(uniqueAids.map((aid) => aid.toString()));
  const toViewSamplesByAid = new Map<string, VideoMinuteSample>();

  for (const sample of toViewSamples) {
    const key = sample.aid.toString();
    if (
      requestedAidKeys.has(key) &&
      isCompleteVideoMinuteSample(sample) &&
      !toViewSamplesByAid.has(key)
    ) {
      toViewSamplesByAid.set(key, sample);
    }
  }

  return {
    toViewSamples: [...toViewSamplesByAid.values()],
    favoriteFallbackAids: uniqueAids.filter(
      (aid) => !toViewSamplesByAid.has(aid.toString()),
    ),
  };
}

export function planFavoriteFallbackBatches(
  requestedAids: bigint[],
  toViewSamples: VideoMinuteSample[],
  batchSize: number,
): bigint[][] {
  const { favoriteFallbackAids } = partitionMinuteSamplingCoverage(
    requestedAids,
    toViewSamples,
  );
  const batches: bigint[][] = [];

  for (let index = 0; index < favoriteFallbackAids.length; index += batchSize) {
    batches.push(favoriteFallbackAids.slice(index, index + batchSize));
  }

  return batches;
}
