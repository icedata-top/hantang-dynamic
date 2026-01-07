import { parse } from "csv-parse";
import { createReadStream } from "fs";
import { resolve } from "path";
import { config } from "../config";
import { Database } from "../core/database";
import { DetailsService } from "../services/details.service";
import { logger } from "../utils/logger";
import type { VideoData } from "../types";
import { exportData } from "../utils/exporter/exporter";
import { notifyNewVideos } from "../utils/notifier/notifier";
import type { BiliDynamicCard } from "../types";

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

    const workers = Array.from(
        { length: Math.min(poolSize, items.length) },
        () => worker(),
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
    const targetCol = colIndex !== -1 && colIndex + 1 < args.length
        ? args[colIndex + 1]
        : "bvid";

    logger.info(
        `Starting CSV import from ${filePath} using column '${targetCol}'`,
    );
    logger.info(`Pool size: ${POOL_SIZE}`);

    const db = Database.getInstance();
    await db.init(config.database.path);
    const detailsService = new DetailsService();

    // Read all rows into memory
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

    logger.info(`Loaded ${rows.length} rows. Starting processing...`);

    // Process using pool
    const results = await runWithPool(
        rows,
        POOL_SIZE,
        async (row, index) => {
            const id = row[targetCol];
            if (!id) {
                logger.warn(
                    `Row ${
                        index + 1
                    }: Column '${targetCol}' not found or empty.`,
                );
                return null;
            }

            try {
                const { video, relatedVideos } = await detailsService
                    .processVideoById(id, true);
                if (video) {
                    // Handle relations recursively (basic DFS/BFS as before, but per video)
                    // Note: Recursive relation processing currently is NOT pooled inside this task,
                    // but processVideoById's recursive logic (if we add it) would be.
                    // For now, let's just do single depth queue processing here as before,
                    // but inside the pooled worker.

                    const queue = [...relatedVideos];
                    const processedBvids = new Set<string>();
                    if (video.bvid) processedBvids.add(video.bvid);
                    const collectedVideos: VideoData[] = [video];

                    const enableRecommendation =
                        config.processing?.features?.enableRecommendation ??
                            false;
                    const maxDepth =
                        config.processing?.features?.maxRecommendationDepth ??
                            1;

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
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(
                    `[${
                        index + 1
                    }/${rows.length}] Failed to process ${id}: ${msg}`,
                );
            }
            return null;
        },
    );

    // Flatten results
    const allNewVideos = results.flat().filter((v): v is VideoData =>
        v !== null
    );

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

    // Process current queue items
    // Since we are already inside a worker, avoid spawning more heavy concurrency here to prevent deadlock or overload?
    // Actually JS is single threaded event loop helper, so 'Promise.all' might be better than sequential for relations?
    // But we are limited by rateLimiter in `detailsService` anyway.

    // Let's stick to sequential for relations within a task to be safe, or small parallelism.
    // 'processVideoById' uses rateLimiter.

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
        } catch (e) {
            // suppress error log for relations to avoid noise? or log debug
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
