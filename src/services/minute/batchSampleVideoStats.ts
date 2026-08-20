import {
  favoriteClient,
  favoriteDirectClient,
  type RequestConfig,
} from "../../api/client";
import { config } from "../../config";
import {
  minuteFallbackResponseMissesTotal,
  watchLaterFallbackBatchesTotal,
  watchLaterFallbackVideosTotal,
} from "../../metrics/registry";
import type { VideoMinuteSample } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
import { isMinuteCounter } from "./completeSample";
import {
  partitionMinuteSamplingCoverage,
  planFavoriteFallbackBatches,
} from "./samplingPlan";
import {
  sampleWatchLaterToViewAccountsWithStatus,
  type ToViewRequestAccount,
  type WatchLaterToViewAccount,
} from "./toview";

interface BiliFavoriteResourceInfo {
  id?: unknown;
  bvid?: unknown;
  cnt_info?: unknown;
}

interface BiliFavoriteCounterInfo {
  coin: number;
  collect: number;
  danmaku: number;
  play: number;
  reply: number;
  share: number;
  thumb_up: number;
}

type UnknownRecord = { [key: string]: unknown };

interface ValidatedBiliFavoriteResourceInfo extends BiliFavoriteResourceInfo {
  id: number;
  cnt_info: BiliFavoriteCounterInfo;
}

type MinuteFallbackResponseMissReason =
  | "api_failure"
  | "invalid_response"
  | "missing_response_item"
  | "invalid_response_item";

export interface BiliFavoriteResponse {
  code: number;
  message?: string;
  data?: unknown;
}

export interface BatchSampleDependencies {
  fetchStatsBatch(aids: bigint[]): Promise<BiliFavoriteResponse>;
}

function toMinuteSample(
  item: unknown,
  sampledAt: Date,
): VideoMinuteSample | null {
  if (!isBiliFavoriteResourceInfo(item) || !Number.isSafeInteger(item.id)) {
    return null;
  }

  return {
    aid: BigInt(item.id),
    time: sampledAt,
    coin: item.cnt_info.coin,
    favorite: item.cnt_info.collect,
    danmaku: item.cnt_info.danmaku,
    view: item.cnt_info.play,
    reply: item.cnt_info.reply,
    share: item.cnt_info.share,
    like: item.cnt_info.thumb_up,
  };
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isBiliFavoriteCounterInfo(
  value: unknown,
): value is BiliFavoriteCounterInfo {
  if (!isUnknownRecord(value)) return false;
  return (
    isMinuteCounter(value.coin) &&
    isMinuteCounter(value.collect) &&
    isMinuteCounter(value.danmaku) &&
    isMinuteCounter(value.play) &&
    isMinuteCounter(value.reply) &&
    isMinuteCounter(value.share) &&
    isMinuteCounter(value.thumb_up)
  );
}

function isBiliFavoriteResourceInfo(
  value: unknown,
): value is ValidatedBiliFavoriteResourceInfo {
  return (
    isUnknownRecord(value) &&
    Number.isSafeInteger(value.id) &&
    typeof value.id === "number" &&
    value.id > 0 &&
    isBiliFavoriteCounterInfo(value.cnt_info)
  );
}

function requestedAidKey(item: unknown): string | null {
  if (
    !isUnknownRecord(item) ||
    typeof item.id !== "number" ||
    !Number.isSafeInteger(item.id) ||
    item.id <= 0
  ) {
    return null;
  }
  return BigInt(item.id).toString();
}

function recordFallbackResponseMiss(
  reason: MinuteFallbackResponseMissReason,
  count: number,
): void {
  if (count === 0) return;
  minuteFallbackResponseMissesTotal.inc({ reason }, count);
}

async function fetchStatsBatch(
  aids: bigint[],
  useDirect: boolean,
): Promise<BiliFavoriteResponse> {
  const resources = aids.map((aid) => `${aid}:2`).join(",");
  const client = useDirect ? favoriteDirectClient : favoriteClient;
  const response = await client.get<BiliFavoriteResponse>("/resource/infos", {
    params: { resources },
    ...({ metadata: { silent: true } } as RequestConfig),
  });
  return response.data;
}

export async function batchSampleVideoStats(
  aids: bigint[],
  options?: {
    batchSize?: number;
    sampledAt?: Date;
    toViewAccounts?: ToViewRequestAccount[];
    watchLaterToViewAccounts?: WatchLaterToViewAccount[];
    unavailableWatchLaterAccountIds?: ReadonlySet<bigint>;
    desiredWatchLaterAidsByAccountId?: ReadonlyMap<bigint, readonly bigint[]>;
    onWatchLaterToViewAccountFailure?(accountId: bigint): void;
    dependencies?: Partial<BatchSampleDependencies>;
  },
): Promise<VideoMinuteSample[]> {
  const sampledAt = options?.sampledAt ?? new Date();
  const batchSize = options?.batchSize ?? config.minute.batchSize;
  const requestedAids = new Set(aids.map((aid) => aid.toString()));
  const samplesByAid = new Map<string, VideoMinuteSample>();
  let toViewSamples: VideoMinuteSample[] = [];

  if (options?.toViewAccounts && options.watchLaterToViewAccounts) {
    const toViewResult = await sampleWatchLaterToViewAccountsWithStatus(
      options.toViewAccounts,
      options.watchLaterToViewAccounts,
      sampledAt,
    );
    for (const accountId of toViewResult.failedAccountIds) {
      options.onWatchLaterToViewAccountFailure?.(accountId);
    }
    toViewSamples = toViewResult.samples;
  }

  const coverage = partitionMinuteSamplingCoverage(aids, toViewSamples);
  for (const sample of coverage.toViewSamples) {
    if (requestedAids.has(sample.aid.toString())) {
      samplesByAid.set(sample.aid.toString(), sample);
    }
  }

  const unavailableDesiredAids = new Set<string>();
  for (const accountId of options?.unavailableWatchLaterAccountIds ?? []) {
    for (const aid of options?.desiredWatchLaterAidsByAccountId?.get(
      accountId,
    ) ?? []) {
      unavailableDesiredAids.add(aid.toString());
    }
  }

  for (const aidBatch of planFavoriteFallbackBatches(
    aids,
    toViewSamples,
    batchSize,
  )) {
    const attributableAids = aidBatch.filter((aid) =>
      unavailableDesiredAids.has(aid.toString()),
    );
    if (attributableAids.length > 0) {
      watchLaterFallbackBatchesTotal.inc();
      watchLaterFallbackVideosTotal.inc(attributableAids.length);
    }
    const release = await sharedApiRateLimiter.acquire();
    try {
      const data = options?.dependencies?.fetchStatsBatch
        ? await options.dependencies.fetchStatsBatch(aidBatch)
        : await fetchStatsBatchWithFallback(aidBatch);

      if (data.code !== 0) {
        logger.warn(`Minute stats API failed with code ${data.code}`);
        recordFallbackResponseMiss("api_failure", aidBatch.length);
        continue;
      }

      if (!Array.isArray(data.data)) {
        logger.warn("Minute stats API returned an invalid response payload");
        recordFallbackResponseMiss("invalid_response", aidBatch.length);
        continue;
      }

      const validAids = new Set<string>();
      const invalidAids = new Set<string>();
      const requestedBatchAids = new Set(aidBatch.map((aid) => aid.toString()));
      for (const item of data.data) {
        const itemAidKey = requestedAidKey(item);
        const sample = toMinuteSample(item, sampledAt);
        const key = sample?.aid.toString();
        if (
          sample &&
          key &&
          requestedAids.has(key) &&
          requestedBatchAids.has(key)
        ) {
          samplesByAid.set(key, sample);
          validAids.add(key);
        } else if (
          itemAidKey &&
          requestedBatchAids.has(itemAidKey) &&
          !validAids.has(itemAidKey)
        ) {
          invalidAids.add(itemAidKey);
        }
      }

      for (const aidKey of validAids) {
        invalidAids.delete(aidKey);
      }
      const missingCount = aidBatch.length - validAids.size - invalidAids.size;
      if (missingCount > 0) {
        logger.warn(
          `Minute stats favorite fallback missed ${missingCount} requested aid(s)`,
        );
        recordFallbackResponseMiss("missing_response_item", missingCount);
      }
      if (invalidAids.size > 0) {
        logger.warn(
          `Minute stats favorite fallback returned invalid tuples for ${invalidAids.size} aid(s)`,
        );
        recordFallbackResponseMiss("invalid_response_item", invalidAids.size);
      }
    } finally {
      release();
    }
  }

  return [...samplesByAid.values()];
}

async function fetchStatsBatchWithFallback(
  aidBatch: bigint[],
): Promise<BiliFavoriteResponse> {
  try {
    return await fetchStatsBatch(aidBatch, false);
  } catch (proxyError) {
    logger.warn("Minute stats proxy request failed; trying direct request");
    logger.debug(proxyError);
  }

  try {
    return await fetchStatsBatch(aidBatch, true);
  } catch (directError) {
    logger.warn("Minute stats direct request failed");
    logger.debug(directError);
    return {
      code: -1,
      message: "request_failed",
      data: [],
    };
  }
}
