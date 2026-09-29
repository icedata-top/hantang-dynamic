import { fetchVideoFullDetail } from "../api/video.js";
import {
  Database,
  type ProcessedVideoMetadataSweep,
} from "../database/index.js";
import { DetailsService } from "../services/details.service.js";
import type {
  BiliVideoDetailDataForProcessing,
  BiliVideoFullDetailResponse,
  RecommendedVideo,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const BATCH_SIZE = 100;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

interface SourceSnapshot {
  related: RecommendedVideo[];
  viewCount: number | undefined;
}

interface UpdateInfoDatabase {
  close(): Promise<void>;
  getProcessedVideoMetadataCandidates(
    options: ProcessedVideoMetadataSweep,
  ): Promise<Array<{ aid: bigint; bvid: string; pidV2?: number }>>;
  getProcessedVideoMetadataUpperAid(): Promise<bigint | null>;
  hasProcessedVideoById(id: number): Promise<boolean>;
  init(): Promise<void>;
}

interface UpdateInfoDetailsService {
  enrichRelatedVideoMetadata(related: RecommendedVideo[]): Promise<number>;
  processFetchedVideoDetail(
    id: number,
    detail: BiliVideoDetailDataForProcessing,
    options: {
      cover43?: string;
      enrichRelatedMetadata: boolean;
      pidV2?: number;
      processRecommendations: boolean;
      processRelated: boolean;
    },
  ): Promise<{ video: unknown | null }>;
}

export interface UpdateInfoOptions {
  afterAid?: bigint;
  database?: UpdateInfoDatabase;
  detailsService?: UpdateInfoDetailsService;
  fetchDetail?: (
    id: string | number,
  ) => Promise<BiliVideoFullDetailResponse | null>;
  onProgress?: (message: string) => void;
  pidV2Whitelist: ReadonlySet<number>;
}

export interface UpdateInfoResult {
  errors: number;
  imported: number;
  metadataUpdated: number;
  scanned: number;
  unresolved: number;
}

function validPidV2(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_POSTGRES_INTEGER
  );
}

function viewCount(detail: BiliVideoFullDetailResponse): number | undefined {
  const view = detail.data.View.stat?.view;
  return typeof view === "number" && Number.isFinite(view) ? view : undefined;
}

function isAboveViewThreshold(value: number | undefined): boolean {
  return value !== undefined && value > 10;
}

function relatedFrom(detail: BiliVideoFullDetailResponse): RecommendedVideo[] {
  return detail.data.Related ?? [];
}

function sourceSnapshot(detail: BiliVideoFullDetailResponse): SourceSnapshot {
  return { related: relatedFrom(detail), viewCount: viewCount(detail) };
}

function unavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("VIDEO_UNAVAILABLE:") ||
      error.message.startsWith("VIDEO_DELETED:"))
  );
}

/** Parse a comma-separated list of explicit pid_v2 values. */
export function parsePidV2Whitelist(value: string | undefined): Set<number> {
  if (value === undefined || value.trim() === "") return new Set();

  const result = new Set<number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid pid_v2 whitelist entry: ${JSON.stringify(part)}`,
      );
    }
    const pidV2 = Number(trimmed);
    if (!validPidV2(pidV2)) {
      throw new Error(
        `Invalid pid_v2 whitelist entry: ${JSON.stringify(part)}`,
      );
    }
    result.add(pidV2);
  }
  return result;
}

async function fetchOrCountUnavailable(
  id: string | number,
  fetchDetail: NonNullable<UpdateInfoOptions["fetchDetail"]>,
  result: UpdateInfoResult,
): Promise<BiliVideoFullDetailResponse | null> {
  try {
    const detail = await fetchDetail(id);
    if (!detail) result.errors++;
    return detail;
  } catch (error) {
    if (unavailableError(error)) {
      result.errors++;
      return null;
    }
    throw error;
  }
}

async function admitRelatedVideos(
  related: RecommendedVideo[],
  context: {
    detailsService: UpdateInfoDetailsService;
    fetchDetail: NonNullable<UpdateInfoOptions["fetchDetail"]>;
    importedAids: Set<number>;
    onImportedSnapshot: (aid: number, snapshot: SourceSnapshot) => void;
    result: UpdateInfoResult;
    whitelist: ReadonlySet<number>;
    database: UpdateInfoDatabase;
  },
): Promise<void> {
  for (const item of related) {
    if (!Number.isSafeInteger(item.aid) || item.aid <= 0) continue;
    if (!validPidV2(item.pid_v2) || !context.whitelist.has(item.pid_v2)) {
      continue;
    }
    if (context.importedAids.has(item.aid)) continue;
    context.importedAids.add(item.aid);
    if (await context.database.hasProcessedVideoById(item.aid)) continue;

    const detail = await fetchOrCountUnavailable(
      item.aid,
      context.fetchDetail,
      context.result,
    );
    if (!detail) continue;

    await context.detailsService.processFetchedVideoDetail(
      item.aid,
      detail.data,
      {
        cover43:
          typeof item.cover43 === "string" && item.cover43.length > 0
            ? item.cover43
            : undefined,
        pidV2: item.pid_v2,
        enrichRelatedMetadata: false,
        processRecommendations: false,
        processRelated: false,
      },
    );
    context.onImportedSnapshot(item.aid, sourceSnapshot(detail));
    context.result.imported++;
  }
}

async function visitCandidates(
  database: UpdateInfoDatabase,
  options: Omit<ProcessedVideoMetadataSweep, "afterAid" | "limit"> & {
    afterAid?: bigint;
  },
  visit: (candidate: {
    aid: bigint;
    bvid: string;
    pidV2?: number;
  }) => Promise<void>,
): Promise<void> {
  let afterAid = options.afterAid ?? 0n;
  while (true) {
    const page = await database.getProcessedVideoMetadataCandidates({
      ...options,
      afterAid,
      limit: BATCH_SIZE,
    });
    const last = page[page.length - 1];
    if (!last) return;
    for (const candidate of page) {
      await visit(candidate);
    }
    if (page.length < BATCH_SIZE) return;
    afterAid = last.aid;
  }
}

/**
 * Manually enrich metadata for the AIDs that existed when this run began.
 * The second pass follows only one A→B recommendation layer for reverse fill.
 */
export async function runUpdateInfo(
  options: UpdateInfoOptions,
): Promise<UpdateInfoResult> {
  const database = options.database ?? Database.getInstance();
  const detailsService = options.detailsService ?? new DetailsService();
  const fetchDetail =
    options.fetchDetail ??
    ((id) =>
      typeof id === "number"
        ? fetchVideoFullDetail({ aid: id })
        : fetchVideoFullDetail({ bvid: id }));
  const progress = options.onProgress ?? ((message) => logger.info(message));
  const result: UpdateInfoResult = {
    errors: 0,
    imported: 0,
    metadataUpdated: 0,
    scanned: 0,
    unresolved: 0,
  };
  const importedAids = new Set<number>();
  const snapshots = new Map<bigint, SourceSnapshot>();

  await database.init();
  try {
    const createdBefore = new Date();
    const throughAid = await database.getProcessedVideoMetadataUpperAid();
    if (throughAid === null) {
      progress("Update-info complete: no processed videos.");
      return result;
    }
    const originalSweep = {
      createdBefore,
      throughAid,
      ...(options.afterAid !== undefined ? { afterAid: options.afterAid } : {}),
    };
    const seenBridges = new Set<bigint>();
    const highViewSources = new Set<bigint>();
    await visitCandidates(
      database,
      { ...originalSweep, onlyMissingPidV2: false },
      async (source) => {
        result.scanned++;
        progress(
          `Update-info source aid=${source.aid}, scanned=${result.scanned}`,
        );
        const detail = await fetchOrCountUnavailable(
          source.bvid || Number(source.aid),
          fetchDetail,
          result,
        );
        if (!detail) return;
        const snapshot = sourceSnapshot(detail);
        snapshots.set(source.aid, snapshot);
        if (!isAboveViewThreshold(snapshot.viewCount)) return;
        result.metadataUpdated +=
          await detailsService.enrichRelatedVideoMetadata(snapshot.related);
        await admitRelatedVideos(snapshot.related, {
          database,
          detailsService,
          fetchDetail,
          importedAids,
          onImportedSnapshot: (aid, imported) =>
            snapshots.set(BigInt(aid), imported),
          result,
          whitelist: options.pidV2Whitelist,
        });
      },
    );

    await visitCandidates(
      database,
      { ...originalSweep, onlyMissingPidV2: true },
      async (source) => {
        const snapshot = snapshots.get(source.aid);
        if (!snapshot || !isAboveViewThreshold(snapshot.viewCount)) return;
        highViewSources.add(source.aid);
        for (const bridge of snapshot.related) {
          if (!Number.isSafeInteger(bridge.aid) || bridge.aid <= 0) continue;
          const bridgeAid = BigInt(bridge.aid);
          if (seenBridges.has(bridgeAid)) continue;
          seenBridges.add(bridgeAid);
          let bridgeSnapshot = snapshots.get(bridgeAid);
          if (!bridgeSnapshot) {
            const detail = await fetchOrCountUnavailable(
              bridge.aid,
              fetchDetail,
              result,
            );
            if (!detail) continue;
            bridgeSnapshot = sourceSnapshot(detail);
            snapshots.set(bridgeAid, bridgeSnapshot);
          }
          if (!isAboveViewThreshold(bridgeSnapshot.viewCount)) continue;
          result.metadataUpdated +=
            await detailsService.enrichRelatedVideoMetadata(
              bridgeSnapshot.related,
            );
          await admitRelatedVideos(bridgeSnapshot.related, {
            database,
            detailsService,
            fetchDetail,
            importedAids,
            onImportedSnapshot: (aid, imported) =>
              snapshots.set(BigInt(aid), imported),
            result,
            whitelist: options.pidV2Whitelist,
          });
        }
      },
    );

    await visitCandidates(
      database,
      { ...originalSweep, onlyMissingPidV2: true },
      async (source) => {
        if (highViewSources.has(source.aid)) result.unresolved++;
      },
    );
    progress(
      `Update-info complete: scanned=${result.scanned}, metadata-updated=${result.metadataUpdated}, imported=${result.imported}, unresolved=${result.unresolved}, unavailable=${result.errors}`,
    );
    return result;
  } finally {
    await database.close();
  }
}
