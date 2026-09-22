import type {
  ProcessedVideoBatchItem,
  ProcessedVideoRecommendationRefresh,
} from "../database/index.js";
import type {
  BiliVideoDetailDataForProcessing,
  BiliVideoFullDetailResponse,
  RecommendedVideo,
  VideoData,
} from "../types/index.js";
import { sharedRecommendationApiRateLimiter } from "../utils/apiRateLimiter.js";
import { filterVideo } from "../utils/filter.js";
import type { RateLimiter } from "../utils/rateLimiter.js";

const API_POOL_SIZE = 20;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export interface RecommendationSource {
  aid: bigint;
  bvid?: string;
}

export interface RecommendationRefreshDatabase {
  getProcessedVideoAids(aids: ReadonlyArray<bigint>): Promise<Set<bigint>>;
  markVideosProcessedWithCollectionState(
    items: ReadonlyArray<ProcessedVideoBatchItem>,
  ): Promise<number>;
  refreshProcessedVideosFromRecommendations(
    videos: ReadonlyArray<ProcessedVideoRecommendationRefresh>,
  ): Promise<number>;
  upsertPidV2Names(
    names: ReadonlyArray<{ pidV2: number; name: string }>,
  ): Promise<number>;
}

export interface RecommendationDetailParser {
  processVideoDetailResponse(
    detail: BiliVideoDetailDataForProcessing,
    options: { storeOwner: false },
  ): Promise<{ videoData: VideoData }>;
}

export interface RecommendationRefreshResult {
  errors: number;
  imported: number;
  metadataUpdated: number;
  snapshots: Map<bigint, { related: RecommendedVideo[]; viewCount?: number }>;
}

function validPidV2(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_POSTGRES_INTEGER
  );
}

function validAid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recommendationRefresh(
  video: RecommendedVideo,
): ProcessedVideoRecommendationRefresh | null {
  if (!video || typeof video !== "object" || !validAid(video.aid)) {
    return null;
  }
  const ownerMid = video.owner?.mid;
  return {
    aid: BigInt(video.aid),
    ...(typeof video.bvid === "string" && video.bvid.length > 0
      ? { bvid: video.bvid }
      : {}),
    ...(typeof video.title === "string" ? { title: video.title } : {}),
    ...(typeof video.desc === "string" ? { description: video.desc } : {}),
    ...(typeof video.pic === "string" ? { pic: video.pic } : {}),
    ...(typeof video.cover43 === "string" && video.cover43.length > 0
      ? { cover43: video.cover43 }
      : {}),
    ...(Number.isSafeInteger(video.tid) && video.tid > 0
      ? { typeId: video.tid }
      : {}),
    ...(validAid(ownerMid) ? { userId: BigInt(ownerMid) } : {}),
    ...(Number.isSafeInteger(video.pubdate) && video.pubdate >= 0
      ? { pubdate: video.pubdate }
      : {}),
    ...(validPidV2(video.pid_v2) ? { pidV2: video.pid_v2 } : {}),
  };
}

function snapshot(detail: BiliVideoFullDetailResponse): {
  related: RecommendedVideo[];
  viewCount?: number;
} {
  const view = detail.data.View.stat?.view;
  return {
    related: detail.data.Related ?? [],
    ...(typeof view === "number" && Number.isFinite(view)
      ? { viewCount: view }
      : {}),
  };
}

async function runPool<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(API_POOL_SIZE, values.length) }, run),
  );
  return results;
}

/** Bounded recommendation collector shared by manual and scheduled callers. */
export class RecommendationRefreshService {
  constructor(
    private readonly options: {
      database: RecommendationRefreshDatabase;
      detailsService: RecommendationDetailParser;
      fetchDetail: (
        id: string | number,
      ) => Promise<BiliVideoFullDetailResponse | null>;
      pidV2Whitelist: ReadonlySet<number>;
      rateLimiter?: Pick<RateLimiter, "acquire">;
    },
  ) {}

  async collectForAids(
    sources: ReadonlyArray<RecommendationSource>,
  ): Promise<RecommendationRefreshResult> {
    let errors = 0;
    const fetch = async (id: string | number) => {
      const release = await (
        this.options.rateLimiter ?? sharedRecommendationApiRateLimiter
      ).acquire();
      try {
        return await this.options.fetchDetail(id);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("VIDEO_UNAVAILABLE:") ||
            error.message.startsWith("VIDEO_DELETED:"))
        ) {
          return null;
        }
        throw error;
      } finally {
        release();
      }
    };

    const fetched = await runPool(sources, async (source) => ({
      aid: source.aid,
      detail: await fetch(source.bvid || Number(source.aid)),
    }));
    const snapshots = new Map<
      bigint,
      { related: RecommendedVideo[]; viewCount?: number }
    >();
    const related: RecommendedVideo[] = [];
    for (const item of fetched) {
      if (!item.detail) {
        errors++;
        continue;
      }
      const itemSnapshot = snapshot(item.detail);
      snapshots.set(item.aid, itemSnapshot);
      if ((itemSnapshot.viewCount ?? 0) > 10)
        related.push(...itemSnapshot.related);
    }

    await this.options.database.upsertPidV2Names(
      related.flatMap((item) => {
        const name =
          typeof item.pid_name_v2 === "string" ? item.pid_name_v2.trim() : "";
        return validPidV2(item.pid_v2) && name.length > 0
          ? [{ pidV2: item.pid_v2, name }]
          : [];
      }),
    );

    const recommendations = [
      ...new Map(
        related.flatMap((item) => {
          const refresh = recommendationRefresh(item);
          return refresh ? [[refresh.aid, refresh] as const] : [];
        }),
      ).values(),
    ];
    const existing = await this.options.database.getProcessedVideoAids(
      recommendations.map((item) => item.aid),
    );
    const metadataUpdated =
      await this.options.database.refreshProcessedVideosFromRecommendations(
        recommendations.filter((item) => existing.has(item.aid)),
      );

    const admissions = [
      ...new Map(
        related
          .filter(
            (item) =>
              validAid(item.aid) &&
              validPidV2(item.pid_v2) &&
              this.options.pidV2Whitelist.has(item.pid_v2) &&
              !existing.has(BigInt(item.aid)),
          )
          .map((item) => [item.aid, item] as const),
      ).values(),
    ];
    const admissionDetails = await runPool(admissions, async (item) => ({
      item,
      detail: await fetch(item.aid),
    }));
    const persisted: ProcessedVideoBatchItem[] = [];
    for (const { item, detail } of admissionDetails) {
      if (!detail) continue;
      const { videoData } =
        await this.options.detailsService.processVideoDetailResponse(
          detail.data,
          { storeOwner: false },
        );
      videoData.pid_v2 = item.pid_v2 as number;
      if (typeof item.cover43 === "string" && item.cover43.length > 0) {
        videoData.cover43 = item.cover43;
      }
      const filtered = await filterVideo(videoData);
      persisted.push({ video: videoData, filtered: filtered !== null });
    }
    const imported =
      await this.options.database.markVideosProcessedWithCollectionState(
        persisted,
      );
    return { errors, imported, metadataUpdated, snapshots };
  }
}
