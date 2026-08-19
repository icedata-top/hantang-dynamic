import {
  favoriteClient,
  favoriteDirectClient,
  type RequestConfig,
} from "../../api/client";
import { config } from "../../config";
import {
  watchLaterFallbackBatchesTotal,
  watchLaterFallbackVideosTotal,
} from "../../metrics/registry";
import type { VideoMinuteSample } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
import { isMinuteCounter } from "./completeSample";
import { planFavoriteFallbackBatches } from "./samplingPlan";
import {
  sampleWatchLaterToViewAccountsWithStatus,
  type ToViewRequestAccount,
  type WatchLaterToViewAccount,
} from "./toview";

interface BiliFavoriteResourceInfo {
  id: number;
  bvid?: string;
  cnt_info?: {
    coin?: number;
    collect?: number;
    danmaku?: number;
    play?: number;
    reply?: number;
    share?: number;
    thumb_up?: number;
  };
}

export interface BiliFavoriteResponse {
  code: number;
  message?: string;
  data?: BiliFavoriteResourceInfo[];
}

export interface BatchSampleDependencies {
  fetchStatsBatch(aids: bigint[]): Promise<BiliFavoriteResponse>;
}

function toMinuteSample(
  item: BiliFavoriteResourceInfo,
  sampledAt: Date,
): VideoMinuteSample | null {
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || !item.cnt_info) {
    return null;
  }

  const counters = [
    item.cnt_info.coin,
    item.cnt_info.collect,
    item.cnt_info.danmaku,
    item.cnt_info.play,
    item.cnt_info.reply,
    item.cnt_info.share,
    item.cnt_info.thumb_up,
  ];
  if (counters.some((counter) => !isMinuteCounter(counter))) {
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

  if (options?.toViewAccounts && options.watchLaterToViewAccounts) {
    const toViewResult = await sampleWatchLaterToViewAccountsWithStatus(
      options.toViewAccounts,
      options.watchLaterToViewAccounts,
      sampledAt,
    );
    for (const accountId of toViewResult.failedAccountIds) {
      options.onWatchLaterToViewAccountFailure?.(accountId);
    }
    for (const sample of toViewResult.samples) {
      if (requestedAids.has(sample.aid.toString())) {
        samplesByAid.set(sample.aid.toString(), sample);
      }
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
    [...samplesByAid.values()],
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

      if (data.code !== 0 || !Array.isArray(data.data)) {
        logger.warn(`Minute stats API failed with code ${data.code}`);
        continue;
      }

      for (const item of data.data) {
        const sample = toMinuteSample(item, sampledAt);
        if (sample && requestedAids.has(sample.aid.toString())) {
          samplesByAid.set(sample.aid.toString(), sample);
        }
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
