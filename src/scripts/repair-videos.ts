import { config } from "../config/index.js";
import { Database } from "../database/index.js";
import { DetailsService } from "../services/details.service.js";
import { bv2av } from "../utils/bvid.js";
import { logger } from "../utils/logger.js";

const POOL_SIZE = config.application.concurrencyLimit || 20;

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
        `[${index}/${total}] ${bvid}: aid=${BigInt(video.aid)}, user_id=${
          BigInt(
            video.user_id,
          )
        }`,
      );
      return { success: true, skipped: false };
    }

    // video is null means it was deleted or filtered
    // logger.warn(`[${index}/${total}] Video ${bvid} not found or filtered`);
    return { success: false, skipped: true };
  } catch (error) {
    const errorMsg = error instanceof Error
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

  const workers = Array.from(
    { length: Math.min(poolSize, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

export async function runRepairVideos(
  filter?: string,
  options: { fixAids?: boolean } = {},
) {
  logger.info("Starting video data repair script");
  if (filter) {
    logger.info(`Filter applied: ${filter}`);
  }
  logger.info(`Pool size: ${POOL_SIZE}`);

  const db = Database.getInstance();
  await db.init(config.database.url);

  const detailsService = new DetailsService();

  try {
    if (options.fixAids) {
      logger.info("=== Repairing aid mismatches ===");
      await repairAids(db);
    }
    // Use lightweight getBvidList instead of loading full VideoData objects
    const allBvids = await db.getBvidList(filter);
    // Deduplicate by bvid to avoid concurrent processing of same video
    const bvids = [...new Set(allBvids)];
    logger.info(
      `Found ${allBvids.length} videos, ${bvids.length} unique bvids to repair`,
    );

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    const results = await runWithPool(bvids, POOL_SIZE, async (bvid, index) => {
      return processVideo(detailsService, bvid, index + 1, bvids.length);
    });

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
  } finally {
    await db.close();
  }
}

/**
 * Scan all rows for aid/bvid mismatches (caused by old bigint bugs) and fix
 * them in a single transaction.  Two-pass strategy: first shift all wrong aids
 * into a safe negative range to avoid PK collisions, then assign correct aids.
 */
async function repairAids(db: Database): Promise<void> {
  const pool = db.getPool();
  const { rows } = await pool.query(`SELECT bvid, aid FROM processed_videos`);

  const bvids: string[] = [];
  const correctAids: string[] = [];

  for (const row of rows) {
    const bvid = row.bvid as string;
    const currentAid = BigInt(row.aid);
    const correctAid = bv2av(bvid);
    if (currentAid !== BigInt(correctAid)) {
      bvids.push(bvid);
      correctAids.push(correctAid.toString());
      logger.info(
        `Aid mismatch: bvid=${bvid} current=${currentAid} correct=${correctAid}`,
      );
    }
  }

  if (bvids.length === 0) {
    logger.info("No aid mismatches found");
    return;
  }

  logger.info(`Fixing ${bvids.length} aid mismatches...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Shift wrong aids into a safe negative range (2^62 below zero).
    // All correct aids are in [0, 2^51), so subtracted values can never
    // collide with any existing correct aid.
    await client.query(
      `UPDATE processed_videos
       SET aid = aid - 4611686018427387904
       WHERE bvid = ANY($1::text[])`,
      [bvids],
    );

    // Assign correct aids
    await client.query(
      `UPDATE processed_videos
       SET aid = corrections.correct_aid::bigint
       FROM unnest($1::text[], $2::bigint[]) AS corrections(bvid, correct_aid)
       WHERE processed_videos.bvid = corrections.bvid`,
      [bvids, correctAids],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  logger.info(`Fixed ${bvids.length} aid mismatches`);
}
