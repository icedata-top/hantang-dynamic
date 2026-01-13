import { fetchVideoFullDetail } from "../api/video.js";
import { config } from "../config/index.js";
import { Database } from "../core/database.js";
import type { VideoData } from "../types/models/video.js";
import { logger } from "../utils/logger.js";

const POOL_SIZE = config.application.concurrencyLimit || 20;

async function processVideo(
  db: Database,
  bvid: string,
  index: number,
  total: number,
): Promise<{ success: boolean; skipped: boolean }> {
  try {
    const fullDetail = await fetchVideoFullDetail({ bvid });

    if (!fullDetail) {
      logger.warn(
        `[${index}/${total}] Video ${bvid} not found (deleted?), skipping`,
      );
      return { success: false, skipped: true };
    }

    const view = fullDetail.data.View;
    const tagString =
      fullDetail.data.Tags?.map((t) => t.tag_name).join(";") || "";

    const updatedVideo: VideoData = {
      // Core identifiers
      aid: view.aid,
      bvid: view.bvid,

      // User info
      user_id: view.owner.mid,
      staff: view.staff?.map((s) => BigInt(s.mid)),

      // Category
      type_id: view.tid,
      tid_v2: view.tid_v2,

      // Content
      title: view.title,
      description: view.desc,
      dynamic: view.dynamic || undefined,
      pic: view.pic,
      tag: tagString,
      tag_new: fullDetail.data.Tags?.map((t) => t.tag_name),
      participle: fullDetail.data.participle,

      // Timing
      pubdate: view.pubdate,
      ctime: view.ctime,

      // Flags
      is_deleted: false,
      copyright: view.copyright,

      // Extras
      extras: {
        duration: view.duration,
        videos: view.videos,
        state: view.state,
        cid: view.cid,
        mission_id: view.mission_id,
        ugc_season_id: view.ugc_season?.id,
        dimension: view.dimension,
        rights: view.rights,
        argue_info: view.argue_info,
        honor_reply: view.honor_reply,
      },
    };

    await db.markVideoProcessed(updatedVideo, false);

    logger.info(
      `[${index}/${total}] ${bvid}: aid=${BigInt(
        updatedVideo.aid,
      )}, user_id=${BigInt(updatedVideo.user_id)}`,
    );
    return { success: true, skipped: false };
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

export async function runRepairVideos(filter?: string) {
  logger.info("Starting video data repair script");
  if (filter) {
    logger.info(`Filter applied: ${filter}`);
  }
  logger.info(`Pool size: ${POOL_SIZE}`);

  const db = Database.getInstance();
  await db.init(config.database.path);

  try {
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
      return processVideo(db, bvid, index + 1, bvids.length);
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
