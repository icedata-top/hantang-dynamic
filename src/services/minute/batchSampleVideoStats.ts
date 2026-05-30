import {
  medialistClient,
  medialistDirectClient,
  type RequestConfig,
} from "../../api/client";
import { config } from "../../config";
import type { VideoMinuteSample } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";

interface BiliMedialistResourceInfo {
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

interface BiliMedialistResponse {
  code: number;
  message?: string;
  data?: BiliMedialistResourceInfo[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toMinuteSample(
  item: BiliMedialistResourceInfo,
  sampledAt: Date,
): VideoMinuteSample | null {
  if (!item.id || !item.cnt_info) return null;

  return {
    aid: BigInt(item.id),
    time: sampledAt,
    coin: item.cnt_info.coin ?? null,
    favorite: item.cnt_info.collect ?? null,
    danmaku: item.cnt_info.danmaku ?? null,
    view: item.cnt_info.play ?? null,
    reply: item.cnt_info.reply ?? null,
    share: item.cnt_info.share ?? null,
    like: item.cnt_info.thumb_up ?? null,
  };
}

async function fetchStatsBatch(
  aids: bigint[],
  useDirect: boolean,
): Promise<BiliMedialistResponse> {
  const resources = aids.map((aid) => `${aid}:2`).join(",");
  const client = useDirect ? medialistDirectClient : medialistClient;
  const response = await client.get<BiliMedialistResponse>(
    "/gateway/base/resource/infos",
    {
      params: { resources },
      ...({ metadata: { silent: true } } as RequestConfig),
    },
  );
  return response.data;
}

export async function batchSampleVideoStats(
  aids: bigint[],
  options?: { batchSize?: number; sampledAt?: Date },
): Promise<VideoMinuteSample[]> {
  const sampledAt = options?.sampledAt ?? new Date();
  const batchSize = options?.batchSize ?? config.minute.batchSize;
  const samples: VideoMinuteSample[] = [];

  for (const aidBatch of chunk(aids, batchSize)) {
    const release = await sharedApiRateLimiter.acquire();
    try {
      const data = await fetchStatsBatchWithFallback(aidBatch);

      if (data.code !== 0 || !Array.isArray(data.data)) {
        logger.warn(`Minute stats API failed with code ${data.code}`);
        continue;
      }

      for (const item of data.data) {
        const sample = toMinuteSample(item, sampledAt);
        if (sample) {
          samples.push(sample);
        }
      }
    } finally {
      release();
    }
  }

  return samples;
}

async function fetchStatsBatchWithFallback(
  aidBatch: bigint[],
): Promise<BiliMedialistResponse> {
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
