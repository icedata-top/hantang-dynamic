import {
  favoriteClient as defaultFavoriteClient,
  favoriteDirectClient as defaultFavoriteDirectClient,
} from "../../api/client";
import { config } from "../../config";
import { minuteFallbackResponseMissesTotal } from "../../metrics/registry";
import type { VideoMinuteSample } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
import { isMinuteCounter } from "./completeSample";
import { partitionMinuteSamplingCoverage } from "./samplingPlan";
import {
  MINUTE_REQUEST_TIMEOUT_MS,
  sampleWatchLaterToViewAccountsWithStatus,
  type ToViewRequestAccount,
} from "./toview";

interface BiliFavoriteCounterInfo {
  coin?: number;
  collect?: number;
  danmaku?: number;
  play: number;
  reply?: number;
  share?: number;
  thumb_up?: number;
}

type UnknownRecord = { [key: string]: unknown };

interface ValidatedBiliFavoriteResourceInfo {
  aid: bigint;
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
  favoriteClient: FavoriteRequestClient;
  favoriteDirectClient: FavoriteRequestClient;
}

interface FavoriteRequestClient {
  get(
    url: string,
    config: {
      params: { resources: string };
      noRetry: true;
      timeout: number;
      metadata: { silent: true };
    },
  ): Promise<{ data: BiliFavoriteResponse }>;
}

export function selectWatchLaterRouting(
  aids: readonly bigint[],
  observedAccountIdsByAid: ReadonlyMap<string, readonly bigint[]>,
  healthyAccountIds: ReadonlySet<bigint>,
): Map<bigint, bigint[]> {
  const selected = new Map<bigint, bigint[]>();
  const seen = new Set<string>();
  for (const aid of aids) {
    const key = aid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const accountId = [...(observedAccountIdsByAid.get(key) ?? [])]
      .filter((id) => id > 0n && healthyAccountIds.has(id))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0];
    if (accountId === undefined) continue;
    const accountAids = selected.get(accountId) ?? [];
    accountAids.push(aid);
    selected.set(accountId, accountAids);
  }
  return selected;
}

function toMinuteSample(
  item: unknown,
  sampledAt: Date,
): VideoMinuteSample | null {
  const resource = parseBiliFavoriteResourceInfo(item);
  if (resource === null) return null;

  return {
    aid: resource.aid,
    time: sampledAt,
    view: resource.cnt_info.play,
    ...(resource.cnt_info.coin === undefined
      ? {}
      : { coin: resource.cnt_info.coin }),
    ...(resource.cnt_info.collect === undefined
      ? {}
      : { favorite: resource.cnt_info.collect }),
    ...(resource.cnt_info.danmaku === undefined
      ? {}
      : { danmaku: resource.cnt_info.danmaku }),
    ...(resource.cnt_info.reply === undefined
      ? {}
      : { reply: resource.cnt_info.reply }),
    ...(resource.cnt_info.share === undefined
      ? {}
      : { share: resource.cnt_info.share }),
    ...(resource.cnt_info.thumb_up === undefined
      ? {}
      : { like: resource.cnt_info.thumb_up }),
  };
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function parseBiliFavoriteCounterInfo(
  value: unknown,
): BiliFavoriteCounterInfo | null {
  if (!isUnknownRecord(value)) return null;
  const play = parseMinuteCounter(value.play);
  if (play === null) return null;

  const counters: BiliFavoriteCounterInfo = { play };
  const optionalFields = [
    "coin",
    "collect",
    "danmaku",
    "reply",
    "share",
    "thumb_up",
  ] as const;
  for (const field of optionalFields) {
    if (!(field in value)) continue;
    const counter = parseMinuteCounter(value[field]);
    if (counter === null) return null;
    counters[field] = counter;
  }
  return counters;
}

function parseBiliFavoriteResourceInfo(
  value: unknown,
): ValidatedBiliFavoriteResourceInfo | null {
  if (!isUnknownRecord(value)) return null;
  const aid = parsePositiveAid(value.id);
  const cntInfo = parseBiliFavoriteCounterInfo(value.cnt_info);
  if (aid === null || cntInfo === null) return null;
  return { aid, cnt_info: cntInfo };
}

function requestedAidKey(item: unknown): string | null {
  return isUnknownRecord(item)
    ? (parsePositiveAid(item.id)?.toString() ?? null)
    : null;
}

function parsePositiveAid(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const aid = BigInt(value);
  return aid > 0n ? aid : null;
}

function parseMinuteCounter(value: unknown): number | null {
  if (isMinuteCounter(value)) return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return isMinuteCounter(parsed) ? parsed : null;
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
  client: FavoriteRequestClient,
): Promise<BiliFavoriteResponse> {
  const resources = aids.map((aid) => `${aid}:2`).join(",");
  const response = await client.get("/resource/infos", {
    params: { resources },
    noRetry: true,
    timeout: MINUTE_REQUEST_TIMEOUT_MS,
    metadata: { silent: true },
  });
  return response.data;
}

export async function batchSampleVideoStats(
  aids: bigint[],
  options?: {
    batchSize?: number;
    sampledAt?: Date;
    toViewAccounts?: ToViewRequestAccount[];
    observedWatchLaterAccountIdsByAid?: ReadonlyMap<string, readonly bigint[]>;
    healthyWatchLaterAccountIds?: ReadonlySet<bigint>;
    onWatchLaterToViewAccountFailure?(accountId: bigint): void;
    dependencies?: Partial<BatchSampleDependencies>;
  },
): Promise<VideoMinuteSample[]> {
  const sampledAt = options?.sampledAt ?? new Date();
  const batchSize = options?.batchSize ?? config.minute.batchSize;
  const requestedAids = new Set(aids.map((aid) => aid.toString()));
  const samplesByAid = new Map<string, VideoMinuteSample>();
  const toViewSamples: VideoMinuteSample[] = [];

  const routing = selectWatchLaterRouting(
    aids,
    options?.observedWatchLaterAccountIdsByAid ?? new Map(),
    options?.healthyWatchLaterAccountIds ?? new Set(),
  );
  if (options?.toViewAccounts && routing.size > 0) {
    const toViewResult = await sampleWatchLaterToViewAccountsWithStatus(
      options.toViewAccounts,
      [...routing.keys()].map((accountId) => ({ accountId })),
      sampledAt,
    );
    for (const accountId of toViewResult.failedAccountIds) {
      options.onWatchLaterToViewAccountFailure?.(accountId);
    }
    for (const [accountId, accountAids] of routing) {
      const accountSamples =
        toViewResult.samplesByAccountId.get(accountId) ?? [];
      const accountAidKeys = new Set(accountAids.map((aid) => aid.toString()));
      toViewSamples.push(
        ...accountSamples.filter((sample) =>
          accountAidKeys.has(sample.aid.toString()),
        ),
      );
    }
  }

  const coverage = partitionMinuteSamplingCoverage(aids, toViewSamples);
  for (const sample of coverage.toViewSamples) {
    if (requestedAids.has(sample.aid.toString())) {
      samplesByAid.set(sample.aid.toString(), sample);
    }
  }

  for (
    let index = 0;
    index < coverage.favoriteFallbackAids.length;
    index += batchSize
  ) {
    const aidBatch = coverage.favoriteFallbackAids.slice(
      index,
      index + batchSize,
    );
    const release = await sharedApiRateLimiter.acquire();
    try {
      let data: BiliFavoriteResponse;
      try {
        data = options?.dependencies?.fetchStatsBatch
          ? await options.dependencies.fetchStatsBatch(aidBatch)
          : await fetchStatsBatchWithFallback(
              aidBatch,
              options?.dependencies?.favoriteClient ?? defaultFavoriteClient,
              options?.dependencies?.favoriteDirectClient ??
                defaultFavoriteDirectClient,
            );
      } catch (error) {
        recordFallbackResponseMiss("api_failure", aidBatch.length);
        throw error;
      }

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
  favoriteClient: FavoriteRequestClient,
  favoriteDirectClient: FavoriteRequestClient,
): Promise<BiliFavoriteResponse> {
  try {
    return await fetchStatsBatch(aidBatch, favoriteClient);
  } catch (proxyError) {
    logger.warn("Minute stats proxy request failed; trying direct request");
    logger.debug(proxyError);
  }

  try {
    return await fetchStatsBatch(aidBatch, favoriteDirectClient);
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
