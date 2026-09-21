import { fetchVideoFullDetail } from "../api/video.js";
import {
  Database,
  type ProcessedVideoMetadataSweep,
} from "../database/index.js";
import { DetailsService } from "../services/details.service.js";
import {
  type RecommendationDetailParser,
  type RecommendationRefreshDatabase,
  RecommendationRefreshService,
} from "../services/recommendation-refresh.service.js";
import type { BiliVideoFullDetailResponse } from "../types/index.js";
import { logger } from "../utils/logger.js";

const BATCH_SIZE = 100;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

interface UpdateInfoDatabase extends RecommendationRefreshDatabase {
  close(): Promise<void>;
  getProcessedVideoMetadataCandidates(
    options: ProcessedVideoMetadataSweep,
  ): Promise<Array<{ aid: bigint; bvid: string; pidV2?: number }>>;
  getProcessedVideoMetadataUpperAid(): Promise<bigint | null>;
  getProcessedVideoAidsMissingPidV2(
    aids: ReadonlyArray<bigint>,
  ): Promise<Set<bigint>>;
  init(): Promise<void>;
}

export interface UpdateInfoOptions {
  afterAid?: bigint;
  database?: UpdateInfoDatabase;
  detailsService?: RecommendationDetailParser;
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

async function visitCandidates(
  database: UpdateInfoDatabase,
  options: Omit<ProcessedVideoMetadataSweep, "afterAid" | "limit"> & {
    afterAid?: bigint;
  },
  visit: (
    candidates: Array<{ aid: bigint; bvid: string; pidV2?: number }>,
  ) => Promise<void>,
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
    await visit(page);
    if (page.length < BATCH_SIZE) return;
    afterAid = last.aid;
  }
}

async function countMissingPidV2(
  database: UpdateInfoDatabase,
  aids: ReadonlySet<bigint>,
): Promise<number> {
  let missing = 0;
  const values = [...aids];
  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    missing += (
      await database.getProcessedVideoAidsMissingPidV2(
        values.slice(index, index + BATCH_SIZE),
      )
    ).size;
  }
  return missing;
}

/**
 * Enrich only the AIDs present when this run begins. Missing pid_v2 sources
 * receive one reverse recommendation pass; imports never recurse.
 */
export async function runUpdateInfo(
  options: UpdateInfoOptions,
): Promise<UpdateInfoResult> {
  const database = options.database ?? Database.getInstance();
  const detailsService = options.detailsService ?? new DetailsService();
  const fetchDetail =
    options.fetchDetail ??
    ((id: string | number) =>
      typeof id === "number"
        ? fetchVideoFullDetail({ aid: id })
        : fetchVideoFullDetail({ bvid: id }));
  const progress =
    options.onProgress ?? ((message: string) => logger.info(message));
  const result: UpdateInfoResult = {
    errors: 0,
    imported: 0,
    metadataUpdated: 0,
    scanned: 0,
    unresolved: 0,
  };

  await database.init();
  try {
    const createdBefore = new Date();
    const throughAid = await database.getProcessedVideoMetadataUpperAid();
    if (throughAid === null) {
      progress("Update-info complete: no processed videos.");
      return result;
    }
    const sweep = {
      createdBefore,
      throughAid,
      ...(options.afterAid === undefined ? {} : { afterAid: options.afterAid }),
    };
    const collector = new RecommendationRefreshService({
      database,
      detailsService,
      fetchDetail,
      pidV2Whitelist: options.pidV2Whitelist,
    });

    const highViewMissingPidAids = new Set<bigint>();
    await visitCandidates(
      database,
      { ...sweep, onlyMissingPidV2: false },
      async (sources) => {
        result.scanned += sources.length;
        progress(
          `Update-info source aid=${sources[0]?.aid}, scanned=${result.scanned}`,
        );
        const collected = await collector.collectForAids(sources);
        result.errors += collected.errors;
        result.imported += collected.imported;
        result.metadataUpdated += collected.metadataUpdated;
        for (const [aid, source] of collected.snapshots) {
          if ((source.viewCount ?? 0) > 10) highViewMissingPidAids.add(aid);
        }
      },
    );

    await visitCandidates(
      database,
      { ...sweep, onlyMissingPidV2: true },
      async (sources) => {
        const collected = await collector.collectForAids(sources);
        result.errors += collected.errors;
        result.imported += collected.imported;
        result.metadataUpdated += collected.metadataUpdated;
        const bridges = [
          ...new Map(
            [...collected.snapshots.values()].flatMap((source) =>
              (source.viewCount ?? 0) > 10
                ? source.related
                    .filter(
                      (item) => Number.isSafeInteger(item.aid) && item.aid > 0,
                    )
                    .map(
                      (item) =>
                        [
                          BigInt(item.aid),
                          { aid: BigInt(item.aid), bvid: item.bvid },
                        ] as const,
                    )
                : [],
            ),
          ).values(),
        ];
        if (bridges.length === 0) return;
        const bridgeCollected = await collector.collectForAids(bridges);
        result.errors += bridgeCollected.errors;
        result.imported += bridgeCollected.imported;
        result.metadataUpdated += bridgeCollected.metadataUpdated;
      },
    );
    result.unresolved = await countMissingPidV2(
      database,
      highViewMissingPidAids,
    );
    progress(
      `Update-info complete: scanned=${result.scanned}, metadata-updated=${result.metadataUpdated}, imported=${result.imported}, unresolved=${result.unresolved}, unavailable=${result.errors}`,
    );
    return result;
  } finally {
    await database.close();
  }
}
