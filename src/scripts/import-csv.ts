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
        : "bvid"; // default to bvid, accept 'aid'

    logger.info(
        `Starting CSV import from ${filePath} using column '${targetCol}'`,
    );

    const db = Database.getInstance();
    await db.init(config.database.path);
    const detailsService = new DetailsService();

    const results: VideoData[] = [];
    const errors: string[] = [];

    const parser = createReadStream(filePath).pipe(
        parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
        }),
    );

    let count = 0;

    for await (const row of parser) {
        count++;
        const id = row[targetCol];

        if (!id) {
            logger.warn(
                `Row ${count}: Column '${targetCol}' not found or empty.`,
            );
            continue;
        }

        logger.info(`Processing row ${count}: ${targetCol}=${id}`);

        try {
            const { video, relatedVideos } = await detailsService
                .processVideoById(id, true);

            if (video) {
                results.push(video);

                // Handle relations
                const queue = [...relatedVideos];
                const processedBvids = new Set<string>();
                if (video.bvid) processedBvids.add(video.bvid);

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
                        results,
                        processedBvids,
                    );
                }
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error(`Failed to process ${id}`, e);
            errors.push(`${id}: ${msg}`);
        }
    }

    // Final export/notify
    if (results.length > 0) {
        logger.info(`Import complete. Processed ${results.length} new videos.`);
        await exportData(results);
        await notifyNewVideos(results);
    } else {
        logger.info("Import complete. No new videos processed.");
    }

    if (errors.length > 0) {
        logger.warn(`Encountered ${errors.length} errors during import.`);
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
            logger.error(`Error processing related video ${bvid}`, e);
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
