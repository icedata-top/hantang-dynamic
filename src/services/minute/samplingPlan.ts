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
  const duplicateToViewAids = new Set<string>();

  for (const sample of toViewSamples) {
    const key = sample.aid.toString();
    if (requestedAidKeys.has(key) && isCompleteVideoMinuteSample(sample)) {
      if (toViewSamplesByAid.has(key)) {
        duplicateToViewAids.add(key);
        continue;
      }
      toViewSamplesByAid.set(key, sample);
    }
  }

  for (const key of duplicateToViewAids) {
    toViewSamplesByAid.delete(key);
  }

  return {
    toViewSamples: [...toViewSamplesByAid.values()],
    favoriteFallbackAids: uniqueAids.filter(
      (aid) => !toViewSamplesByAid.has(aid.toString()),
    ),
  };
}
