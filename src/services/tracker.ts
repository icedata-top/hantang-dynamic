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
import { DetailsService, type RelatedVideoWorkItem } from "./details.service";
import { DynamicsService } from "./dynamics.service";

interface PendingRetry {
  workItem: RelatedVideoWorkItem;
  depth: number;
  processRelated: boolean;
  key: string;
  attempts: number;
  nextAt: number;
  seenRelatedCandidates: Set<string>;
}

export class DynamicTracker {
  private account: AccountContext;
  private isRunning = false;
  private dynamicsService: DynamicsService;
  private detailsService: DetailsService;
  private pendingRetries = new Map<string, PendingRetry>();
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

    const minDynamicId = stateManager.lastFeedDynamicId;
    let maxDynamicId = minDynamicId;
    logger.info(
      `[uid=${this.account.uid}] Checking dynamics after ${minDynamicId}`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId,
      minTimestamp,
    });
    for await (const page of stream) {
      const { cards } = page;
      logger.info(
        `[uid=${this.account.uid}] Got new dynamic page: ${cards.length} cards`,
      );
      for (const card of cards) {
        dynamicsSeenTotal.inc({
          uid: this.account.uid || "unknown",
          type: String(card.desc.type),
        });
      }
      await Promise.all(
        cards.map((card) => this.detailsService.saveDynamic(card)),
      );
      const processedVideos = await this.processPage(
        cards.filter((card) => card.desc.type === 8 || card.desc.type === 1),
      );
      if (processedVideos.length > 0) {
        videosProcessedTotal.inc(
          { uid: this.account.uid || "unknown" },
          processedVideos.length,
        );
        await exportData(processedVideos);
        await notifyNewVideos(processedVideos);
      }
      await this.drainRetries();
      if (page.maxDynamicId > maxDynamicId) maxDynamicId = page.maxDynamicId;
    }
    await this.flushRetries();
    // Only a completed traversal establishes a safe frontier.
    if (maxDynamicId > minDynamicId)
      stateManager.updateLastFeedDynamicId(maxDynamicId);
  }

  private async processPage(
    dynamics: Array<BiliDynamicCard | RelatedVideoWorkItem>,
    depth = 0,
    seenRelatedCandidates = new Set<string>(),
  ): Promise<VideoData[]> {
    const results: VideoData[] = [];
    const relatedQueue: RelatedVideoWorkItem[] = [];

    const features = config.processing?.features;
    const enableRelatedExpansion =
      features?.enableRelatedExpansion ??
      features?.enableRecommendation ??
      false;
    const maxDepth =
      features?.maxRelatedExpansionDepth ??
      features?.maxRecommendationDepth ??
      1;
    const expandRelated = enableRelatedExpansion && depth < maxDepth;

    for (const dynamic of dynamics) {
      const key = this.getRelatedCandidateKey(dynamic);
      if (key) {
        seenRelatedCandidates.add(key);
      }
    }

    const workItems = dynamics.map((dynamic) =>
      "dynamic" in dynamic ? dynamic : { dynamic, pidV2: undefined },
    );
    const concurrency = Math.min(
      Math.max(1, config.application.concurrencyLimit),
      32,
    );

    // Process in bounded batches instead of spawning hundreds of tasks.
    for (let index = 0; index < workItems.length; index += concurrency) {
      const batch = workItems.slice(index, index + concurrency);
      const processResults = await Promise.allSettled(
        batch.map(async (workItem) => {
          try {
            const result = await this.detailsService.processVideo(
              workItem.dynamic,
              {
                pidV2: workItem.pidV2,
                cover43: workItem.cover43,
                processRelated: expandRelated,
              },
            );
            return { workItem, ...result };
          } catch (error) {
            if (isAccountAuthError(error)) {
              throw error;
            }
            logger.error(
              `Error processing video ${this.getRelatedCandidateKey(workItem) ?? "unknown"}:`,
              error,
            );
            return {
              workItem,
              video: null,
              relatedVideos: [],
              failed: true,
            };
          }
        }),
      );

      for (const result of processResults) {
        if (result.status === "rejected") {
          if (isAccountAuthError(result.reason)) {
            throw result.reason;
          }
          logger.error("Error processing dynamic:", result.reason);
          continue;
        }

        const { workItem, video, relatedVideos, failed } = result.value;
        if (failed) {
          this.enqueueRetry(
            workItem,
            depth,
            expandRelated,
            seenRelatedCandidates,
          );
          continue;
        }
        if (video) {
          results.push(video);
          relatedQueue.push(
            ...this.dedupeRelatedCandidates(
              relatedVideos,
              seenRelatedCandidates,
            ),
          );
        }
      }
    }

    // Recursive processing for related videos
    if (relatedQueue.length > 0) {
      const relatedResults = await this.processPage(
        relatedQueue,
        depth + 1,
        seenRelatedCandidates,
      );
      results.push(...relatedResults);
    }

    // log the processResults
    logger.info(
      `Original dynamic count: ${dynamics.length}, Added video count: ${results.length}`,
    );

    return results;
  }

  private enqueueRetry(
    workItem: RelatedVideoWorkItem,
    depth: number,
    processRelated: boolean,
    seenRelatedCandidates: Set<string>,
  ): void {
    const key = this.getRelatedCandidateKey(workItem);
    if (!key || this.pendingRetries.has(key)) return;
    this.pendingRetries.set(key, {
      workItem,
      depth,
      processRelated,
      key,
      attempts: 0,
      nextAt: Date.now() + config.application.apiWaitTime,
      seenRelatedCandidates,
    });
    logger.warn(`[uid=${this.account.uid}] Queued ${key} for retry`);
  }

  private async drainRetries(force = false): Promise<void> {
    const due = [...this.pendingRetries.values()].filter(
      (item) => force || item.nextAt <= Date.now(),
    );
    const recovered: VideoData[] = [];
    for (const item of due) {
      this.pendingRetries.delete(item.key);
      const { video, relatedVideos, failed } =
        await this.detailsService.processVideo(item.workItem.dynamic, {
          pidV2: item.workItem.pidV2,
          cover43: item.workItem.cover43,
          processRelated: item.processRelated,
        });
      if (failed) {
        const attempts = item.attempts + 1;
        if (attempts >= config.application.apiRetryTimes) {
          logger.error(
            `[uid=${this.account.uid}] Dropping ${item.key} after ${attempts} retries`,
          );
        } else {
          this.pendingRetries.set(item.key, {
            ...item,
            attempts,
            nextAt: Date.now() + config.application.apiWaitTime,
          });
        }
        continue;
      }
      if (!video) continue;
      recovered.push(video);
      if (item.processRelated && relatedVideos.length > 0) {
        recovered.push(
          ...(await this.processPage(
            relatedVideos,
            item.depth + 1,
            item.seenRelatedCandidates,
          )),
        );
      }
    }

    if (recovered.length > 0) {
      videosProcessedTotal.inc(
        { uid: this.account.uid || "unknown" },
        recovered.length,
      );
      await exportData(recovered);
      await notifyNewVideos(recovered);
    }
  }

  private async flushRetries(): Promise<void> {
    // drainRetries() only picks due items, so sleep first and force the drain.
    // The attempt budget lives in drainRetries(), not in a pass count here.
    while (this.pendingRetries.size > 0) {
      await sleep(config.application.apiWaitTime);
      await this.drainRetries(true);
    }
  }

  private dedupeRelatedCandidates(
    candidates: RelatedVideoWorkItem[],
    seenCandidates: Set<string>,
  ): RelatedVideoWorkItem[] {
    const deduped: RelatedVideoWorkItem[] = [];

    for (const candidate of candidates) {
      const key = this.getRelatedCandidateKey(candidate);
      if (!key || seenCandidates.has(key)) {
        continue;
      }

      seenCandidates.add(key);
      deduped.push(candidate);
    }

    return deduped;
  }

  private getRelatedCandidateKey(
    input: BiliDynamicCard | RelatedVideoWorkItem,
  ): string | null {
    const candidate = "dynamic" in input ? input.dynamic : input;
    const bvid = candidate.desc?.bvid;
    if (bvid) {
      return `bvid:${bvid}`;
    }

    const aid = candidate.desc?.rid;
    if (aid) {
      return `aid:${aid.toString()}`;
    }

    return null;
  }

  async runRetrospective() {
    if (!this.isRunning) return;

    const retrospectiveDays = config.application.retrospectiveDays || 30;
    const minTimestamp = Date.now() / 1000 - retrospectiveDays * 86400;

    logger.info(
      `[uid=${this.account.uid}] Starting retrospective scan for past ${retrospectiveDays} days`,
    );

    const stream = this.dynamicsService.fetchDynamicsStream({
      minDynamicId: 0n,
      minTimestamp,
    });
    for await (const { cards } of stream) {
      logger.info(
        `[uid=${this.account.uid}] Retrospective page: ${cards.length} cards`,
      );
      await Promise.all(
        cards.map((card) => this.detailsService.saveDynamic(card)),
      );
      await this.processPage(
        cards.filter((card) => card.desc.type === 8 || card.desc.type === 1),
      );
    }

    await this.flushRetries();
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
