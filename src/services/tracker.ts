import { isAccountAuthError } from "../api/client";
import { fetchFollowingList } from "../api/relation";
import { generateBiliTicket } from "../api/signatures/biliTicket";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import { Database } from "../database";
import {
  dynamicsSeenTotal,
  fetchCycleDurationSeconds,
  fetchCyclesTotal,
  lastSuccessfulFetchTimestampSeconds,
  videosProcessedTotal,
} from "../metrics/registry";
import type { BiliDynamicCard, VideoData } from "../types";
import { sleep } from "../utils/datetime";
import { exportData } from "../utils/exporter/exporter";
import { logger } from "../utils/logger";
import { notifyNewVideos } from "../utils/notifier/notifier";
import { DetailsService } from "./details.service";
import { DynamicsService, KNOWN_DYNAMIC_TYPES } from "./dynamics.service";

const ALL_DYNAMIC_TYPES = Object.values(KNOWN_DYNAMIC_TYPES) as number[];
const PROCESS_VIDEO_TYPES = new Set<number>([
  KNOWN_DYNAMIC_TYPES.VIDEO,
  KNOWN_DYNAMIC_TYPES.FORWARD,
]);

export class DynamicTracker {
  private account: AccountContext;
  private isRunning = false;
  private dynamicsService: DynamicsService;
  private detailsService: DetailsService;
  private db = Database.getInstance();
  private retrospectiveTimer: ReturnType<typeof setInterval> | null = null;
  private followingStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private followingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(account: AccountContext) {
    this.account = account;
    this.dynamicsService = new DynamicsService(account);
    this.detailsService = new DetailsService({
      webInterfaceClient: account.webInterfaceClient,
    });
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.initialize();
    this.startRetrospectiveSchedule();
    this.startFollowingSyncSchedule();

    while (this.isRunning) {
      const uid = this.account.uid || "unknown";
      const endFetchCycle = fetchCycleDurationSeconds.startTimer({ uid });
      try {
        await this.checkDynamics();
        endFetchCycle();
        fetchCyclesTotal.inc({ uid, result: "success" });
        lastSuccessfulFetchTimestampSeconds.set({ uid }, Date.now() / 1000);

        await sleep(config.application.fetchInterval);
      } catch (error) {
        endFetchCycle();
        fetchCyclesTotal.inc({ uid, result: "error" });
        if (isAccountAuthError(error)) {
          logger.error(
            `[uid=${this.account.uid}] Authenticated tracker disabled: ${error.message}`,
          );
          this.stop();
          break;
        }
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
    if (this.retrospectiveTimer) {
      clearInterval(this.retrospectiveTimer);
      this.retrospectiveTimer = null;
    }
    if (this.followingStartupTimer) {
      clearTimeout(this.followingStartupTimer);
      this.followingStartupTimer = null;
    }
    if (this.followingTimer) {
      clearInterval(this.followingTimer);
      this.followingTimer = null;
    }
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
    const stateManager = this.account.stateManager;
    const minTimestamp =
      Date.now() / 1000 - config.application.maxHistoryDays * 86400;

    const minDynamicIdByType: Partial<Record<number, bigint>> = {};
    for (const t of ALL_DYNAMIC_TYPES) {
      minDynamicIdByType[t] = stateManager.getLastDynamicIdForType(t);
    }

    logger.info(
      `[uid=${this.account.uid}] Checking dynamics, watermarks: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(minDynamicIdByType).map(([k, v]) => [
            k,
            v?.toString(),
          ]),
        ),
      )}`,
    );

    const maxIdByType = new Map<number, bigint>();

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicIdByType,
      minTimestamp,
      types: ALL_DYNAMIC_TYPES,
    });

    for await (const { typeCode, cards } of stream) {
      logger.info(
        `[uid=${this.account.uid}] Got new dynamic page: type=${typeCode}, ${cards.length} cards`,
      );
      dynamicsSeenTotal.inc(
        { uid: this.account.uid || "unknown", type: String(typeCode) },
        cards.length,
      );

      // Save all dynamics to DB immediately (decouple storage from processing)
      await Promise.all(
        cards.map((card) => this.detailsService.saveDynamic(card)),
      );

      // Update per-type max watermark
      for (const card of cards) {
        const id = BigInt(card.desc.dynamic_id_str);
        const prev = maxIdByType.get(typeCode) ?? BigInt(0);
        if (id > prev) maxIdByType.set(typeCode, id);
      }

      // Only process video-relevant types (8=video, 1=forward)
      if (PROCESS_VIDEO_TYPES.has(typeCode)) {
        const processedVideos = await this.processPage(cards);

        if (processedVideos.length > 0) {
          videosProcessedTotal.inc(
            { uid: this.account.uid || "unknown" },
            processedVideos.length,
          );
          await exportData(processedVideos);
          await notifyNewVideos(processedVideos);
        }
      }
    }

    // Persist per-type watermarks after full stream
    for (const [type, maxId] of maxIdByType) {
      const prev = stateManager.getLastDynamicIdForType(type);
      if (maxId > prev) {
        stateManager.updateLastDynamicIdForType(type, maxId);
      }
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
    const processResults = await Promise.allSettled(
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
          if (isAccountAuthError(error)) {
            throw error;
          }
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
      if (result.status === "rejected") {
        if (isAccountAuthError(result.reason)) {
          throw result.reason;
        }
        logger.error("Error processing dynamic:", result.reason);
        continue;
      }

      if (result.value) {
        results.push(result.value.video);
        relatedQueue.push(...result.value.relatedVideos);
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
    if (!this.isRunning) return;

    const retrospectiveDays = config.application.retrospectiveDays || 30;
    const minTimestamp = Date.now() / 1000 - retrospectiveDays * 86400;

    logger.info(
      `[uid=${this.account.uid}] Starting retrospective scan for past ${retrospectiveDays} days`,
    );

    // Full rescan: all type watermarks start at 0
    const minDynamicIdByType: Partial<Record<number, bigint>> = {};
    for (const t of ALL_DYNAMIC_TYPES) {
      minDynamicIdByType[t] = BigInt(0);
    }

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicIdByType,
      minTimestamp,
      types: ALL_DYNAMIC_TYPES,
    });

    for await (const { typeCode, cards } of stream) {
      logger.info(
        `[uid=${this.account.uid}] Retrospective page: type=${typeCode}, ${cards.length} cards`,
      );

      await Promise.all(
        cards.map((card) => this.detailsService.saveDynamic(card)),
      );

      if (PROCESS_VIDEO_TYPES.has(typeCode)) {
        await this.processPage(cards);
      }
    }

    logger.info(`[uid=${this.account.uid}] Retrospective scan completed`);
  }

  startRetrospectiveSchedule() {
    const interval =
      config.application.retrospectiveInterval || 7 * 24 * 3600 * 1000;

    this.retrospectiveTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.runRetrospective().catch((err) => {
        if (isAccountAuthError(err)) {
          logger.error(
            `[uid=${this.account.uid}] Retrospective auth failure; disabling tracker: ${err.message}`,
          );
          this.stop();
          return;
        }
        logger.error("Retrospective error:", err);
      });
    }, interval);

    logger.info(
      `[uid=${this.account.uid}] Retrospective scan scheduled every ${interval / 86400000} days`,
    );
  }

  /**
   * Sync followed_by / is_following by fetching this account's following list from Bilibili.
   */
  async syncFollowingStatus(): Promise<void> {
    if (!this.isRunning) return;

    const uid = this.account.uid;
    if (!uid) {
      logger.warn(
        "Cannot sync following status: uid not available for this account",
      );
      return;
    }

    logger.info(`[uid=${uid}] Syncing following status from Bilibili...`);
    try {
      const followings = await fetchFollowingList(
        uid,
        true,
        this.account.relationClient,
      );
      const followingIds = new Set(followings.map((f) => f.mid.toString()));
      await this.db.syncFollowingStatus(uid, followingIds);
      this.account.stateManager.updateFollowingSync();
      logger.info(
        `[uid=${uid}] Following status synced: ${followingIds.size} users marked as followed`,
      );
    } catch (error) {
      if (isAccountAuthError(error)) {
        logger.error(
          `[uid=${uid}] Following sync auth failure; disabling tracker: ${error.message}`,
        );
        this.stop();
        return;
      }
      logger.error(`[uid=${uid}] Failed to sync following status:`, error);
    }
  }

  startFollowingSyncSchedule() {
    const intervalMs = 24 * 3600 * 1000;
    const lastSync = this.account.stateManager.lastFollowingSync ?? 0;
    const elapsed = Date.now() - lastSync;

    if (elapsed >= intervalMs) {
      // Never synced, or overdue — delay 30s to avoid hitting API right at startup
      this.followingStartupTimer = setTimeout(
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

    this.followingTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.syncFollowingStatus().catch((err) =>
        logger.error("Following sync error:", err),
      );
    }, intervalMs);
  }
}
