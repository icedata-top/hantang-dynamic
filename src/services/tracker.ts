import { fetchFollowingList } from "../api/relation";
import { generateBiliTicket } from "../api/signatures/biliTicket";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import { Database } from "../database";
import type { BiliDynamicCard, VideoData } from "../types";
import { sleep } from "../utils/datetime";
import { exportData } from "../utils/exporter/exporter";
import { logger } from "../utils/logger";
import { notifyNewVideos } from "../utils/notifier/notifier";
import { DetailsService } from "./details.service";
import { DynamicsService } from "./dynamics.service";

export class DynamicTracker {
  private account: AccountContext;
  private isRunning = false;
  private dynamicsService: DynamicsService;
  private detailsService = new DetailsService();
  private db = Database.getInstance();

  constructor(account: AccountContext) {
    this.account = account;
    this.dynamicsService = new DynamicsService(account);
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.initialize();
    this.startRetrospectiveSchedule();
    this.startFollowingSyncSchedule();

    while (this.isRunning) {
      try {
        await this.checkDynamics();

        await sleep(config.application.fetchInterval);
      } catch (error) {
        logger.error(`[uid=${this.account.uid}] Tracker error:`, error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
        this.account.stateManager.updateUA();
        await sleep(3600);
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  private async initialize() {
    // Initialize BiliTicket
    if (!this.account.stateManager.isTicketValid()) {
      logger.debug(
        `[uid=${this.account.uid}] Generating initial BiliTicket...`,
      );
      const ticketData = await generateBiliTicket();
      if (ticketData) {
        this.account.stateManager.updateTicket(
          ticketData.ticket,
          ticketData.expiresAt,
        );
        logger.info(
          `[uid=${this.account.uid}] BiliTicket initialized successfully`,
        );
      } else {
        logger.debug(
          `[uid=${this.account.uid}] Failed to initialize BiliTicket, continuing without it`,
        );
      }
    } else {
      logger.debug(`[uid=${this.account.uid}] Using existing valid BiliTicket`);
    }
  }

  private async checkDynamics() {
    const lastDynamicId = this.account.stateManager.lastDynamicId;
    let maxDynamicId = lastDynamicId;
    const minTimestamp =
      Date.now() / 1000 - config.application.maxHistoryDays * 86400;

    logger.info(
      `[uid=${this.account.uid}] Checking dynamics since ID: ${lastDynamicId}, Timestamp: ${minTimestamp}`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId: lastDynamicId,
      minTimestamp,
      types: ["video", "forward"],
    });

    for await (const dynamics of stream) {
      logger.info(
        `[uid=${this.account.uid}] Got new dynamic page with ${dynamics.length} dynamics`,
      );
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

    // Update state after full cycle
    if (maxDynamicId > lastDynamicId) {
      this.account.stateManager.updateLastDynamicId(maxDynamicId);
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
      `[uid=${this.account.uid}] Starting retrospective scan for past ${retrospectiveDays} days`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId: BigInt(0), // Scan all
      minTimestamp,
      types: ["video", "forward"],
    });

    for await (const dynamics of stream) {
      logger.info(
        `[uid=${this.account.uid}] Got new page with ${dynamics.length} dynamics`,
      );
      await this.processPage(dynamics);
    }

    logger.info(`[uid=${this.account.uid}] Retrospective scan completed`);
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
      `[uid=${this.account.uid}] Retrospective scan scheduled every ${interval / 86400000} days`,
    );
  }

  /**
   * Sync followed_by / is_following by fetching this account's following list from Bilibili.
   */
  async syncFollowingStatus(): Promise<void> {
    const uid = this.account.uid;
    if (!uid) {
      logger.warn(
        "Cannot sync following status: uid not available for this account",
      );
      return;
    }

    logger.info(`[uid=${uid}] Syncing following status from Bilibili...`);
    try {
      const followings = await fetchFollowingList(uid, true);
      const followingIds = new Set(followings.map((f) => f.mid.toString()));
      await this.db.syncFollowingStatus(uid, followingIds);
      this.account.stateManager.updateFollowingSync();
      logger.info(
        `[uid=${uid}] Following status synced: ${followingIds.size} users marked as followed`,
      );
    } catch (error) {
      logger.error(`[uid=${uid}] Failed to sync following status:`, error);
    }
  }

  startFollowingSyncSchedule() {
    const intervalMs = 24 * 3600 * 1000;
    const lastSync = this.account.stateManager.lastFollowingSync ?? 0;
    const elapsed = Date.now() - lastSync;

    if (elapsed >= intervalMs) {
      // Never synced, or overdue — delay 30s to avoid hitting API right at startup
      setTimeout(
        () =>
          this.syncFollowingStatus().catch((err) =>
            logger.error("Following sync error:", err),
          ),
        30_000,
      );
      logger.info(
        lastSync === 0
          ? `[uid=${this.account.uid}] Following status sync scheduled in 30s (first run)`
          : `[uid=${this.account.uid}] Following status sync scheduled in 30s (overdue by ${Math.round((elapsed - intervalMs) / 3600_000)}h)`,
      );
    } else {
      logger.info(
        `[uid=${this.account.uid}] Following status sync skipped at startup (last ran ${Math.round(elapsed / 3600_000)}h ago, next in ${Math.round((intervalMs - elapsed) / 3600_000)}h)`,
      );
    }

    setInterval(
      () =>
        this.syncFollowingStatus().catch((err) =>
          logger.error("Following sync error:", err),
        ),
      intervalMs,
    );
  }
}
