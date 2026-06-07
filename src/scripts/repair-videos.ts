import { fetchVideoFullDetailBatch } from "../api/video.js";
import { config } from "../config/index.js";
import { type BvidListQuery, Database } from "../database/index.js";
import { DetailsService } from "../services/details.service.js";
import type { BiliVideoBatchDetailItemResponse } from "../types/index.js";
import { logger } from "../utils/logger.js";

const POOL_SIZE = config.application.concurrencyLimit || 20;
const VIDEO_DETAIL_BATCH_SIZE = 50;

type RepairFilterColumn =
  | "aid"
  | "bvid"
  | "copyright"
  | "created_at"
  | "ctime"
  | "description"
  | "dynamic"
  | "extras"
  | "is_deleted"
  | "is_filtered"
  | "notes"
  | "participle"
  | "pic"
  | "pubdate"
  | "staff"
  | "tag"
  | "tag_new"
  | "tid_v2"
  | "title"
  | "type_id"
  | "updated_at"
  | "user_id";

export interface RepairColumnFilterOperators {
  contains?: unknown;
  eq?: unknown;
  gt?: unknown;
  gte?: unknown;
  hasAll?: unknown[];
  hasAny?: unknown[];
  in?: unknown[];
  isEmpty?: boolean;
  isNull?: boolean;
  lt?: unknown;
  lte?: unknown;
  max?: unknown;
  min?: unknown;
}

export type RepairColumnFilterValue =
  | boolean
  | number
  | RepairColumnFilterOperators
  | string
  | unknown[];

export interface RepairVideoFilter
  extends Partial<Record<RepairFilterColumn, RepairColumnFilterValue>> {
  columns?: Partial<Record<RepairFilterColumn, RepairColumnFilterValue>>;
  limit?: number;
}

interface RepairOptions {
  fixAids?: boolean;
  bvids?: string[];
  filter?: RepairVideoFilter;
}

export interface RepairResult {
  total: number;
  success: number;
  skipped: number;
  errors: number;
  aidMismatchesFixed: number;
}

async function processVideo(
  detailsService: DetailsService,
  bvid: string,
  index: number,
  total: number,
): Promise<{ success: boolean; skipped: boolean }> {
  try {
    const { video } = await detailsService.processVideoById(bvid, {
      processRelated: false,
      skipCacheCheck: true,
    });

    if (video) {
      logger.info(
        `[${index}/${total}] ${bvid}: aid=${BigInt(video.aid)}, user_id=${BigInt(
          video.user_id,
        )}`,
      );
      return { success: true, skipped: false };
    }

    // video is null means it was deleted or filtered
    // logger.warn(`[${index}/${total}] Video ${bvid} not found or filtered`);
    return { success: false, skipped: true };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : JSON.stringify(error) || String(error);
    logger.error(`[${index}/${total}] Error processing ${bvid}: ${errorMsg}`);
    return { success: false, skipped: false };
  }
}

async function processBatchItem(
  detailsService: DetailsService,
  bvid: string,
  item: BiliVideoBatchDetailItemResponse | undefined,
  index: number,
  total: number,
): Promise<{ success: boolean; skipped: boolean }> {
  try {
    if (!item) {
      throw new Error("Missing batch item response");
    }

    if (item.code !== 0) {
      await detailsService.processVideoApiCode(bvid, item.code, item.message);
      return { success: false, skipped: true };
    }

    if (!item.data) {
      throw new Error("Batch item response missing data");
    }

    const { video } = await detailsService.processFetchedVideoDetail(
      bvid,
      item.data,
      {
        processRelated: false,
      },
    );

    if (video) {
      logger.info(
        `[${index}/${total}] ${bvid}: aid=${BigInt(video.aid)}, user_id=${BigInt(
          video.user_id,
        )}`,
      );
      return { success: true, skipped: false };
    }

    return { success: false, skipped: true };
  } catch (error) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : JSON.stringify(error) || String(error);
    logger.error(`[${index}/${total}] Error processing ${bvid}: ${errorMsg}`);
    return { success: false, skipped: false };
  }
}

/**
 * Worker pool implementation: maintains a fixed number of concurrent tasks.
 * When one task completes, the next task from the queue is started.
 */
async function runWithPool<T, R>(
  items: T[],
  poolSize: number,
  processor: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await processor(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(poolSize, items.length) }, () =>
    worker(),
  );

  await Promise.all(workers);
  return results;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function processVideoBatch(
  detailsService: DetailsService,
  bvids: string[],
  offset: number,
  total: number,
): Promise<Array<{ success: boolean; skipped: boolean }>> {
  const items = await fetchVideoFullDetailBatch(bvids, bvids.length);
  const itemById = new Map(items.map((item) => [item.id, item]));

  return runWithPool(bvids, POOL_SIZE, async (bvid, index) =>
    processBatchItem(
      detailsService,
      bvid,
      itemById.get(bvid),
      offset + index + 1,
      total,
    ),
  );
}

async function runWithBatchProxy(
  detailsService: DetailsService,
  bvids: string[],
): Promise<Array<{ success: boolean; skipped: boolean }> | null> {
  if (!config.bilibili.apiProxyUrl) {
    return null;
  }

  logger.info(
    `Using proxy video detail batch endpoint with batch size ${VIDEO_DETAIL_BATCH_SIZE}`,
  );

  const results: Array<{ success: boolean; skipped: boolean }> = [];
  const chunks = chunkArray(bvids, VIDEO_DETAIL_BATCH_SIZE);

  try {
    for (const [chunkIndex, chunk] of chunks.entries()) {
      results.push(
        ...(await processVideoBatch(
          detailsService,
          chunk,
          chunkIndex * VIDEO_DETAIL_BATCH_SIZE,
          bvids.length,
        )),
      );
    }
    return results;
  } catch (error) {
    logger.warn(
      "Video detail batch request failed; falling back to single-video repair",
      error,
    );
    return null;
  }
}

export async function runRepairVideos(
  filter?: string,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const db = Database.getInstance();
  await db.init(config.database.url);

  try {
    return await runRepairVideosWithDatabase(db, filter, options);
  } finally {
    await db.close();
  }
}

export async function runRepairVideosWithDatabase(
  db: Database,
  filter?: string,
  options: RepairOptions = {},
): Promise<RepairResult> {
  logger.info("Starting video data repair script");
  if (filter) {
    logger.info(`Filter applied: ${filter}`);
  }
  logger.info(`Pool size: ${POOL_SIZE}`);

  const detailsService = new DetailsService();
  let aidMismatchesFixed = 0;

  if (options.fixAids) {
    logger.info("=== Repairing aid mismatches ===");
    aidMismatchesFixed = await repairAids(db);
  }

  // Use lightweight getBvidList instead of loading full VideoData objects
  const allBvids =
    options.bvids ??
    (await db.getBvidList(
      options.filter ? buildRepairBvidListQuery(options.filter) : filter,
    ));
  // Deduplicate by bvid to avoid concurrent processing of same video
  const bvids = [...new Set(allBvids)];
  logger.info(
    `Found ${allBvids.length} videos, ${bvids.length} unique bvids to repair`,
  );

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  const results =
    (await runWithBatchProxy(detailsService, bvids)) ??
    (await runWithPool(bvids, POOL_SIZE, async (bvid, index) => {
      return processVideo(detailsService, bvid, index + 1, bvids.length);
    }));

  for (const result of results) {
    if (result.success) successCount++;
    else if (result.skipped) skippedCount++;
    else errorCount++;
  }

  logger.info("\n=== Repair Complete ===");
  logger.info(`Total: ${bvids.length}`);
  logger.info(`Success: ${successCount}`);
  logger.info(`Skipped: ${skippedCount}`);
  logger.info(`Errors: ${errorCount}`);

  return {
    aidMismatchesFixed,
    errors: errorCount,
    skipped: skippedCount,
    success: successCount,
    total: bvids.length,
  };
}

function buildRepairBvidListQuery(filter: RepairVideoFilter): BvidListQuery {
  const clauses: string[] = [];
  const params: unknown[] = [];

  function addParam(value: unknown): string {
    params.push(value);
    return `$${params.length}`;
  }

  for (const [column, value] of Object.entries(
    normalizeFilterColumns(filter),
  )) {
    clauses.push(...buildColumnClauses(column as RepairFilterColumn, value));
  }

  return {
    limit: filter.limit,
    params,
    where: clauses.length > 0 ? clauses.join(" AND ") : undefined,
  };

  function buildColumnClauses(
    column: RepairFilterColumn,
    value: RepairColumnFilterValue,
  ): string[] {
    const definition = FILTER_COLUMNS[column];
    const expressions: string[] = [];
    const columnSql = definition.sql;
    const operator =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : { eq: value };

    if ("isNull" in operator) {
      if (typeof operator.isNull !== "boolean") {
        throw new Error(`${column}.isNull must be a boolean`);
      }
      expressions.push(`${columnSql} IS ${operator.isNull ? "" : "NOT "}NULL`);
    }

    if ("eq" in operator) {
      expressions.push(
        `${columnSql} = ${addTypedParam(operator.eq, definition)}`,
      );
    }

    if ("in" in operator) {
      if (definition.kind === "array" || definition.kind === "jsonb") {
        throw new Error(`${column}.in is not supported for ${definition.kind}`);
      }
      expressions.push(buildInClause(columnSql, operator.in, definition));
    }

    if ("min" in operator) {
      assertComparable(column, definition, "min");
      expressions.push(
        `${columnSql} >= ${addTypedParam(operator.min, definition)}`,
      );
    }

    if ("max" in operator) {
      assertComparable(column, definition, "max");
      expressions.push(
        `${columnSql} <= ${addTypedParam(operator.max, definition)}`,
      );
    }

    if ("gte" in operator) {
      assertComparable(column, definition, "gte");
      expressions.push(
        `${columnSql} >= ${addTypedParam(operator.gte, definition)}`,
      );
    }

    if ("lte" in operator) {
      assertComparable(column, definition, "lte");
      expressions.push(
        `${columnSql} <= ${addTypedParam(operator.lte, definition)}`,
      );
    }

    if ("gt" in operator) {
      assertComparable(column, definition, "gt");
      expressions.push(
        `${columnSql} > ${addTypedParam(operator.gt, definition)}`,
      );
    }

    if ("lt" in operator) {
      assertComparable(column, definition, "lt");
      expressions.push(
        `${columnSql} < ${addTypedParam(operator.lt, definition)}`,
      );
    }

    if ("contains" in operator) {
      expressions.push(
        buildContainsClause(columnSql, operator.contains, definition),
      );
    }

    if ("hasAny" in operator) {
      expressions.push(
        buildArrayClause(columnSql, operator.hasAny, definition, "&&"),
      );
    }

    if ("hasAll" in operator) {
      expressions.push(
        buildArrayClause(columnSql, operator.hasAll, definition, "@>"),
      );
    }

    if ("isEmpty" in operator) {
      if (definition.kind !== "array") {
        throw new Error(`${column}.isEmpty is only supported for arrays`);
      }
      if (typeof operator.isEmpty !== "boolean") {
        throw new Error(`${column}.isEmpty must be a boolean`);
      }
      expressions.push(
        `COALESCE(cardinality(${columnSql}), 0) ${
          operator.isEmpty ? "=" : ">"
        } 0`,
      );
    }

    return expressions;
  }

  function assertComparable(
    column: RepairFilterColumn,
    definition: FilterColumnDefinition,
    operator: string,
  ): void {
    if (definition.kind !== "number" && definition.kind !== "timestamp") {
      throw new Error(
        `${column}.${operator} is not supported for ${definition.kind}`,
      );
    }
  }

  function addTypedParam(
    value: unknown,
    definition: FilterColumnDefinition,
  ): string {
    return `${addParam(value)}::${definition.type}`;
  }

  function buildInClause(
    columnSql: string,
    values: unknown,
    definition: FilterColumnDefinition,
  ): string {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${definition.apiName}.in must be a non-empty array`);
    }
    return `${columnSql} = ANY(${addParam(values)}::${definition.arrayType})`;
  }

  function buildContainsClause(
    columnSql: string,
    value: unknown,
    definition: FilterColumnDefinition,
  ): string {
    if (definition.kind === "text") {
      if (typeof value !== "string") {
        throw new Error(`${definition.apiName}.contains must be a string`);
      }
      return `${columnSql} ILIKE ${addParam(`%${value}%`)}`;
    }

    if (definition.kind === "jsonb") {
      return `${columnSql} @> ${addParam(JSON.stringify(value))}::jsonb`;
    }

    if (definition.kind === "array") {
      const arrayValues = Array.isArray(value) ? value : [value];
      return buildArrayClause(columnSql, arrayValues, definition, "&&");
    }

    throw new Error(`${definition.apiName}.contains is not supported`);
  }

  function buildArrayClause(
    columnSql: string,
    values: unknown,
    definition: FilterColumnDefinition,
    operator: "&&" | "@>",
  ): string {
    if (definition.kind !== "array") {
      throw new Error(`${definition.apiName} is not an array column`);
    }

    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${definition.apiName} array filter must be non-empty`);
    }

    return `${columnSql} ${operator} ${addParam(values)}::${definition.arrayType}`;
  }
}

interface FilterColumnDefinition {
  apiName: string;
  arrayType: string;
  kind: "array" | "boolean" | "jsonb" | "number" | "text" | "timestamp";
  sql: string;
  type: string;
}

const FILTER_COLUMNS: Record<RepairFilterColumn, FilterColumnDefinition> = {
  aid: column("aid", "bigint", "bigint[]", "number"),
  bvid: column("bvid", "varchar", "varchar[]", "text"),
  copyright: column("copyright", "integer", "integer[]", "number"),
  created_at: column("created_at", "timestamptz", "timestamptz[]", "timestamp"),
  ctime: column("ctime", "bigint", "bigint[]", "number"),
  description: column("description", "text", "text[]", "text"),
  dynamic: column("dynamic", "text", "text[]", "text"),
  extras: column("extras", "jsonb", "jsonb[]", "jsonb"),
  is_deleted: column("is_deleted", "boolean", "boolean[]", "boolean"),
  is_filtered: column("is_filtered", "boolean", "boolean[]", "boolean"),
  notes: column("notes", "jsonb", "jsonb[]", "jsonb"),
  participle: column("participle", "varchar[]", "varchar[]", "array"),
  pic: column("pic", "varchar", "varchar[]", "text"),
  pubdate: column("pubdate", "bigint", "bigint[]", "number"),
  staff: column("staff", "bigint[]", "bigint[]", "array"),
  tag: column("tag", "text", "text[]", "text"),
  tag_new: column("tag_new", "varchar[]", "varchar[]", "array"),
  tid_v2: column("tid_v2", "integer", "integer[]", "number"),
  title: column("title", "varchar", "varchar[]", "text"),
  type_id: column("type_id", "integer", "integer[]", "number"),
  updated_at: column("updated_at", "timestamptz", "timestamptz[]", "timestamp"),
  user_id: column("user_id", "bigint", "bigint[]", "number"),
};

function column(
  sql: string,
  type: string,
  arrayType: string,
  kind: FilterColumnDefinition["kind"],
): FilterColumnDefinition {
  return {
    apiName: sql,
    arrayType,
    kind,
    sql,
    type,
  };
}

function normalizeFilterColumns(
  filter: RepairVideoFilter,
): Partial<Record<RepairFilterColumn, RepairColumnFilterValue>> {
  const { columns: nestedColumns, limit: _limit, ...topLevelColumns } = filter;
  return { ...topLevelColumns, ...nestedColumns };
}

/**
 * Scan all rows for aid/bvid mismatches (caused by old bigint bugs) and fix
 * them in a single transaction.  Two-pass strategy: first shift all wrong aids
 * into a safe negative range to avoid PK collisions, then assign correct aids.
 */
async function repairAids(db: Database): Promise<number> {
  const pool = db.getPool();

  const { rows: mismatches } = await pool.query(`
    SELECT bvid, aid AS current_aid, bv2av(bvid) AS correct_aid
    FROM processed_videos
    WHERE bv2av(bvid) != aid
  `);

  if (mismatches.length === 0) {
    logger.info("No aid mismatches found");
    return 0;
  }

  for (const row of mismatches) {
    logger.info(
      `Aid mismatch: bvid=${row.bvid} current=${row.current_aid} correct=${row.correct_aid}`,
    );
  }

  logger.info(`Fixing ${mismatches.length} aid mismatches...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Shift wrong aids into a safe negative range (2^62 below zero).
    // All correct aids are in [0, 2^51), so subtracted values can never
    // collide with any existing correct aid.
    await client.query(`
      UPDATE processed_videos
      SET aid = aid - 4611686018427387904
      WHERE bv2av(bvid) != aid
    `);

    // Assign correct aids via the DB function
    await client.query(`
      UPDATE processed_videos
      SET aid = bv2av(bvid)
      WHERE aid < 0
    `);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  logger.info(`Fixed ${mismatches.length} aid mismatches`);
  return mismatches.length;
}
