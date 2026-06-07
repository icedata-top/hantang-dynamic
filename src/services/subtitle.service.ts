import {
  fetchPlayerSubtitleTracks,
  fetchSubtitleJson,
  fetchSubtitleVideoView,
} from "../api/subtitle.js";
import { config } from "../config";
import type { AccountContext } from "../core/account";
import { Database } from "../database";
import type { UpsertSubtitleInput } from "../database/subtitles.js";
import {
  subtitleJobDurationSeconds,
  subtitleJobsTotal,
  subtitleTracksTotal,
} from "../metrics/registry";
import {
  type BiliSubtitleStyle,
  isAiSubtitle,
  isManualSubtitle,
} from "../types/bilibili/subtitle.js";
import { logger } from "../utils/logger";

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(onDone, ms);

    function onDone() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onDone);
      resolve();
    }

    signal.addEventListener("abort", onDone, { once: true });
    if (signal.aborted) onDone();
  });
}

function getSubtitleStyle(json: BiliSubtitleStyle): BiliSubtitleStyle {
  return {
    font_size: json.font_size,
    font_color: json.font_color,
    background_alpha: json.background_alpha,
    background_color: json.background_color,
    Stroke: json.Stroke,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SubtitleService {
  private readonly db = Database.getInstance();
  private readonly account: AccountContext;
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(account: AccountContext) {
    this.account = account;
  }

  start(): void {
    if (this.loopPromise) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.loopPromise = this.loop(this.abortController.signal);
    logger.info(
      `Subtitle service started (interval=${config.subtitle.fetchIntervalMs}ms, uid=${this.account.uid || "unknown"})`,
    );
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.abortController?.abort();
    logger.info("Subtitle service stopping");
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.abortController = null;
    logger.info("Subtitle service stopped");
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processOne();
      } catch (error) {
        logger.error("Subtitle service loop error:", error);
      }

      await cancellableSleep(config.subtitle.fetchIntervalMs, signal);
    }

    this.loopPromise = null;
  }

  private async processOne(): Promise<void> {
    const job = await this.db.selectNextSubtitleJob();
    if (!job) return;

    const endJob = subtitleJobDurationSeconds.startTimer();
    try {
      if (job.isDeleted || !job.bvid) {
        await this.db.updateSubtitleState(job.aid, "skipped");
        subtitleJobsTotal.inc({ outcome: "skipped" });
        return;
      }

      logger.info(
        `Fetching subtitles for aid=${job.aid} bvid=${job.bvid} view=${job.lastView?.toString() ?? "unknown"}`,
      );

      const view = await fetchSubtitleVideoView(
        this.account.webInterfaceClient,
        job.aid,
      );
      if (!view) {
        await this.db.updateSubtitleState(job.aid, "skipped");
        subtitleJobsTotal.inc({ outcome: "skipped" });
        return;
      }

      const bvid = view.bvid || job.bvid;
      let anyManual = await this.db.aidHasManualSubtitle(job.aid);
      let anyAi = false;
      const subtitles: UpsertSubtitleInput[] = [];

      for (const page of view.pages) {
        if (await this.db.cidHasManualSubtitle(job.aid, page.cid)) {
          anyManual = true;
          continue;
        }

        const tracks = await fetchPlayerSubtitleTracks(
          this.account.playerClient,
          bvid,
          page.cid,
        );
        if (tracks.length === 0) continue;

        for (const track of tracks) {
          if (!track.subtitle_url) continue;

          const subtitleJson = await fetchSubtitleJson(track.subtitle_url);
          if (isManualSubtitle(track)) anyManual = true;
          if (isAiSubtitle(track)) anyAi = true;

          subtitles.push({
            aid: job.aid,
            cid: page.cid,
            lan: track.lan,
            lanDoc: track.lan_doc || null,
            subtitleType: track.type,
            aiType: track.ai_type,
            aiStatus: track.ai_status,
            body: subtitleJson.body,
            style: getSubtitleStyle(subtitleJson),
          });
        }
      }

      const storedCount = await this.db.upsertSubtitlesBatch(subtitles);
      if (storedCount > 0) {
        subtitleTracksTotal.inc({ kind: "total" }, storedCount);
        subtitleTracksTotal.inc(
          { kind: "manual" },
          subtitles.filter((item) => item.aiType === 0).length,
        );
        subtitleTracksTotal.inc(
          { kind: "ai" },
          subtitles.filter((item) => item.aiType !== null && item.aiType > 0)
            .length,
        );
      }

      const nextState = anyManual
        ? "has_manual"
        : anyAi
          ? "ai_only"
          : "no_subtitle";
      await this.db.updateSubtitleState(job.aid, nextState);
      subtitleJobsTotal.inc({ outcome: nextState });
    } catch (error) {
      const message = getErrorMessage(error);
      const failure = await this.db.recordSubtitleFailure(job.aid, message);
      subtitleJobsTotal.inc({
        outcome: failure.state === "skipped" ? "skipped_after_retry" : "failed",
      });
      logger.error(
        `Subtitle job failed for aid=${job.aid} failure_count=${failure.failureCount}: ${message}`,
      );
    } finally {
      endJob();
    }
  }
}
