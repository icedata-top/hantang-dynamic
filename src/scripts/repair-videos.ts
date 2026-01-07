import { config } from "../config/index.js";
import { Database } from "../core/database.js";
import { fetchVideoFullDetail } from "../api/video.js";
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
    const tagString = fullDetail.data.Tags?.map((t) => t.tag_name).join(";") ||
      "";

    const updatedVideo: VideoData = {
      aid: view.aid,
      bvid: view.bvid,
      pubdate: view.pubdate,
      title: view.title,
      description: view.desc,
      tag: tagString,
      pic: view.pic,
      type_id: view.tid,
      user_id: view.owner.mid,
      copyright: view.copyright,
    };

    await db.markVideoProcessed(updatedVideo, false);

    logger.info(
      `[${index}/${total}] ${bvid}: aid=${
        BigInt(
          updatedVideo.aid,
        )
      }, user_id=${BigInt(updatedVideo.user_id)}`,
    );
    return { success: true, skipped: false };
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

export async function runRepairVideos() {
  logger.info("Starting video data repair script");
  logger.info(`Pool size: ${POOL_SIZE}`);

  const db = Database.getInstance();
  await db.init(config.database.path);

  try {
    const allVideos = await db.getProcessedVideos();
    // Deduplicate by bvid to avoid concurrent processing of same video
    const seenBvids = new Set<string>();
    const videos = allVideos.filter((v) => {
      if (seenBvids.has(v.bvid)) return false;
      seenBvids.add(v.bvid);
      return true;
    });
    logger.info(
      `Found ${allVideos.length} videos, ${videos.length} unique bvids to repair`,
    );

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    const results = await runWithPool(
      videos,
      POOL_SIZE,
      async (video, index) => {
        return processVideo(db, video.bvid, index + 1, videos.length);
      },
    );

    for (const result of results) {
      if (result.success) successCount++;
      else if (result.skipped) skippedCount++;
      else errorCount++;
    }

    logger.info("\n=== Repair Complete ===");
    logger.info(`Total: ${videos.length}`);
    logger.info(`Success: ${successCount}`);
    logger.info(`Skipped: ${skippedCount}`);
    logger.info(`Errors: ${errorCount}`);
  } finally {
    await db.close();
  }
}
