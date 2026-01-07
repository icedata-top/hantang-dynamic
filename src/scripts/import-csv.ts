import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import cliProgress from "cli-progress";
import { parse } from "csv-parse";
import { config } from "../config";
import { Database } from "../core/database";
import { DetailsService } from "../services/details.service";
import type { BiliDynamicCard, VideoData } from "../types";
import { exportData } from "../utils/exporter/exporter";
import { logger } from "../utils/logger";
import { notifyNewVideos } from "../utils/notifier/notifier";

const POOL_SIZE = config.application.concurrencyLimit || 20;

/**
 * Worker pool implementation: maintains a fixed number of concurrent tasks.
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

export async function runImportCsv() {
  const args = process.argv;
  const importIndex = args.indexOf("--import");
  const colIndex = args.indexOf("--col");

  if (importIndex === -1 || importIndex + 1 >= args.length) {
    logger.error("Please specify a CSV file to import: --import <file>");
    process.exit(1);
  }

  const filePath = resolve(args[importIndex + 1]);
  const targetCol =
    colIndex !== -1 && colIndex + 1 < args.length ? args[colIndex + 1] : "bvid";

  logger.info(
    `Starting CSV import from ${filePath} using column '${targetCol}'`,
  );
  logger.info(`Pool size: ${POOL_SIZE}`);

  const db = Database.getInstance();
  await db.init(config.database.path);
  const detailsService = new DetailsService();

  // Read all rows into memory
  // biome-ignore lint/suspicious/noExplicitAny: CSV parser returns distinct objects based on file content
  const rows: any[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );

  for await (const row of parser) {
    rows.push(row);
  }

  logger.info(`Loaded ${rows.length} rows. Fetching existing IDs...`);

  const idType = targetCol === "aid" ? "aid" : "bvid";
  const existingIds = await db.getAllProcessedIds(idType);

  logger.info(`Found ${existingIds.size} existing videos in DB. Filtering...`);

  // biome-ignore lint/suspicious/noExplicitAny: CSV row type
  const rowsToProcess: any[] = [];
  let skippedImmediately = 0;

  for (const row of rows) {
    const id = row[targetCol];
    // Check if ID exists (handling both string/number input vs string in Set)
    if (id && existingIds.has(String(id))) {
      skippedImmediately++;
    } else {
      rowsToProcess.push(row);
    }
  }

  logger.info(
    `Skipped ${skippedImmediately} videos. Processing ${rowsToProcess.length} remaining...`,
  );

  // Initialize Progress Bar
  const bar = new cliProgress.SingleBar(
    {
      format:
        "Importing [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | OK: {success} | SKIP: {skipped} | ERR: {errors} | {lastOp}",
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic,
  );

  let successCount = 0;
  let skippedCount = skippedImmediately;
  let errorCount = 0;

  bar.start(rows.length, skippedImmediately, {
    success: 0,
    skipped: skippedImmediately,
    errors: 0,
    lastOp: "Starting...",
  });

  // Process using pool
  const results = await runWithPool(
    rowsToProcess,
    POOL_SIZE,
    async (row, _index) => {
      const id = row[targetCol];
      if (!id) {
        skippedCount++;
        bar.increment(1, {
          skipped: skippedCount,
          lastOp: "SKIP Empty ID",
        });
        return null;
      }

      try {
        const { video, relatedVideos } = await detailsService.processVideoById(
          id,
          true,
        );
        if (video) {
          successCount++;
          bar.increment(1, {
            success: successCount,
            lastOp: `OK ${id}`,
          });

          // Handle relations recursively
          const queue = [...relatedVideos];
          const processedBvids = new Set<string>();
          if (video.bvid) processedBvids.add(video.bvid);
          const collectedVideos: VideoData[] = [video];

          const enableRecommendation =
            config.processing?.features?.enableRecommendation ?? false;
          const maxDepth =
            config.processing?.features?.maxRecommendationDepth ?? 1;

          if (enableRecommendation) {
            await processRelatedQueue(
              detailsService,
              queue,
              1,
              maxDepth,
              collectedVideos,
              processedBvids,
            );
          }

          return collectedVideos;
        }
        skippedCount++;
        bar.increment(1, {
          skipped: skippedCount,
          lastOp: `SKIP ${id}`,
        });
      } catch (e: unknown) {
        errorCount++;
        const msg = e instanceof Error ? e.message : String(e);
        // Shorten error message for display
        const shortMsg = msg.length > 20 ? `${msg.substring(0, 20)}...` : msg;
        bar.increment(1, {
          errors: errorCount,
          lastOp: `ERR ${id} ${shortMsg}`,
        });
      }
      return null;
    },
  );

  bar.stop();

  // Flatten results
  const allNewVideos = results.flat().filter((v): v is VideoData => v !== null);

  // Final export/notify
  if (allNewVideos.length > 0) {
    logger.info(
      `Import complete. Processed ${allNewVideos.length} new videos.`,
    );
    await exportData(allNewVideos);
    await notifyNewVideos(allNewVideos);
  } else {
    logger.info("Import complete. No new videos processed.");
  }

  await db.close();
}

async function processRelatedQueue(
  service: DetailsService,
  queue: BiliDynamicCard[],
  depth: number,
  maxDepth: number,
  results: VideoData[],
  seenBvids: Set<string>,
) {
  if (depth >= maxDepth || queue.length === 0) return;

  const nextQueue: BiliDynamicCard[] = [];

  for (const item of queue) {
    const bvid = item.desc?.bvid;
    if (!bvid || seenBvids.has(bvid)) continue;
    seenBvids.add(bvid);

    try {
      const { video, relatedVideos } = await service.processVideoById(
        bvid,
        true,
      );
      if (video) {
        results.push(video);
        nextQueue.push(...relatedVideos);
      }
    } catch (_e) {
      // suppress error log for relations
    }
  }

  if (nextQueue.length > 0) {
    await processRelatedQueue(
      service,
      nextQueue,
      depth + 1,
      maxDepth,
      results,
      seenBvids,
    );
  }
}
