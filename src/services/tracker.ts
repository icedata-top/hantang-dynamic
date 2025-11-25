import { generateBiliTicket } from "../api/signatures/biliTicket";
import { config } from "../config";
import { StateManager } from "../core/state";
import type { BiliDynamicCard, VideoData } from "../types";
import { sleep } from "../utils/datetime";
import { exportData } from "../utils/exporter/exporter";
import { logger } from "../utils/logger";
import { notifyNewVideos } from "../utils/notifier/notifier";
import { DetailsService } from "./details.service";
import { DynamicsService } from "./dynamics.service";

export class DynamicTracker {
  private state = new StateManager();
  private isRunning = false;
  private dynamicsService = new DynamicsService();
  private detailsService = new DetailsService();

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.initialize();
    this.startRetrospectiveSchedule();

    while (this.isRunning) {
      try {
        await this.checkDynamics();
        await sleep(config.application.fetchInterval);
      } catch (error) {
        logger.error("Tracker error:", error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
        this.state.updateUA();
        await sleep(3600);
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  private async initialize() {
    // Initialize Database
    // Assuming DB init is handled in index.ts or singleton ensures it's ready,
    // but good to ensure connection here if needed.
    // The Database.getInstance() is synchronous but init is async.
    // We should probably ensure it's initialized.
    // For now, let's assume index.ts calls db.init().

    // Initialize BiliTicket
    if (!this.state.isTicketValid()) {
      logger.debug("Generating initial BiliTicket...");
      const ticketData = await generateBiliTicket();
      if (ticketData) {
        this.state.updateTicket(ticketData.ticket, ticketData.expiresAt);
        logger.info("BiliTicket initialized successfully");
      } else {
        logger.debug("Failed to initialize BiliTicket, continuing without it");
      }
    } else {
      logger.debug("Using existing valid BiliTicket");
    }
  }

  private async checkDynamics() {
    const lastDynamicId = this.state.lastDynamicId;
    let maxDynamicId = lastDynamicId;
    const minTimestamp =
      Date.now() / 1000 - config.application.maxHistoryDays * 86400;

    logger.info(
      `Checking dynamics since ID: ${lastDynamicId}, Timestamp: ${minTimestamp}`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId: lastDynamicId,
      minTimestamp,
      types: ["video", "forward"],
    });

    for await (const dynamics of stream) {
      logger.info(`Got new dynamic page with ${dynamics.length} dynamics`);
      // Process page immediately
      const processedVideos = await this.processPage(dynamics);

      // Export and Notify
      if (processedVideos.length > 0) {
        await exportData(processedVideos);
        await notifyNewVideos(processedVideos);
      }

      // Update maxDynamicId
      const pageMaxId = Math.max(
        ...dynamics.map((d) => Number(d.desc.dynamic_id)),
      );
      if (pageMaxId > maxDynamicId) {
        maxDynamicId = BigInt(pageMaxId);
      }
    }

    // Update state after full cycle (or incrementally if preferred, but state usually tracks "all read up to here")
    if (maxDynamicId > lastDynamicId) {
      this.state.updateLastDynamicId(maxDynamicId);
    }
  }

  private async processPage(
    dynamics: BiliDynamicCard[],
    depth = 0,
  ): Promise<VideoData[]> {
    const results: VideoData[] = [];
    const relatedQueue: BiliDynamicCard[] = [];

    const enableRecommendation =
      config.processing?.features?.enableRecommendation ?? false;
    const maxDepth = config.processing?.features?.maxRecommendationDepth ?? 1;

    // Process all dynamics concurrently
    const processResults = await Promise.all(
      dynamics.map(async (dynamic) => {
        try {
          const { video, relatedVideos } =
            await this.detailsService.processVideo(
              dynamic,
              enableRecommendation && depth < maxDepth,
            );

          if (video) {
            if (
              enableRecommendation &&
              depth < maxDepth &&
              relatedVideos.length > 0
            ) {
              return { video, relatedVideos: relatedVideos };
            }
          }
          return null;
        } catch (error) {
          logger.error(
            `Error processing dynamic ${dynamic.desc.dynamic_id}:`,
            error,
          );
          return null;
        }
      }),
    );

    // Collect results
    for (const result of processResults) {
      if (result) {
        results.push(result.video);
        relatedQueue.push(...result.relatedVideos);
      }
    }

    // Recursive processing for related videos
    if (relatedQueue.length > 0) {
      const relatedResults = await this.processPage(relatedQueue, depth + 1);
      results.push(...relatedResults);
    }

    // log the processResults
    logger.info(
      `Original dynamic count: ${dynamics.length}, Added video count: ${results.length}`,
    );

    return results;
  }

  async runRetrospective() {
    const retrospectiveDays = config.application.retrospectiveDays || 30;
    const minTimestamp = Date.now() / 1000 - retrospectiveDays * 86400;

    logger.info(
      `Starting retrospective scan for past ${retrospectiveDays} days`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId: BigInt(0), // Scan all
      minTimestamp,
      types: ["video", "forward"],
    });

    for await (const dynamics of stream) {
      // log we got a new page
      logger.info(`Got new page with ${dynamics.length} dynamics`);
      await this.processPage(dynamics);
    }

    logger.info("Retrospective scan completed");
  }

  startRetrospectiveSchedule() {
    const interval =
      config.application.retrospectiveInterval || 7 * 24 * 3600 * 1000;

    setInterval(() => {
      this.runRetrospective().catch((err) =>
        logger.error("Retrospective error:", err),
      );
    }, interval);

    logger.info(
      `Retrospective scan scheduled every ${interval / 86400000} days`,
    );
  }
}
