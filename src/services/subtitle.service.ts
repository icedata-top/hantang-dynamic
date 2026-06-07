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
  subtitleActiveJobs,
  subtitleJobDurationSeconds,
  subtitleJobsTotal,
  subtitleLastTerminalJobTimestampSeconds,
  subtitleLastTickTimestampSeconds,
  subtitleServiceRunning,
  subtitleStateRows,
  subtitleTicksTotal,
  subtitleTracksTotal,
} from "../metrics/registry";
import {
  type BiliSubtitleStyle,
  isAiSubtitle,
  isManualSubtitle,
} from "../types/bilibili/subtitle.js";
import { logger } from "../utils/logger";

const SUBTITLE_STATE_METRIC_LABELS = [
  "not_eligible",
  "pending",
  "has_manual",
  "ai_only",
  "no_subtitle",
  "skipped",
  "unknown",
] as const;

type SubtitleTickOutcome =
  | "no_job"
  | "skipped"
  | "has_manual"
  | "ai_only"
  | "no_subtitle"
  | "failed"
  | "skipped_after_retry"
  | "error";

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
    subtitleServiceRunning.set({ uid: this.account.uid || "unknown" }, 1);
    this.loopPromise = this.loop(this.abortController.signal);
    logger.info(
      `Subtitle service started (interval=${config.subtitle.fetchIntervalMs}ms, uid=${this.account.uid || "unknown"})`,
    );
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.abortController?.abort();
    subtitleServiceRunning.set({ uid: this.account.uid || "unknown" }, 0);
    subtitleActiveJobs.set(0);
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
        subtitleLastTickTimestampSeconds.set(Date.now() / 1000);
        const outcome = await this.processOne();
        this.recordTick(outcome);
      } catch (error) {
        this.recordTick("error");
        logger.error("Subtitle service loop error:", error);
      }

      await cancellableSleep(config.subtitle.fetchIntervalMs, signal);
    }

    this.loopPromise = null;
  }

  private recordTick(outcome: SubtitleTickOutcome): void {
    subtitleTicksTotal.inc({ outcome });
  }

  private async sampleStateMetrics(): Promise<void> {
    try {
      const counts = await this.db.getSubtitleStateCounts();
      for (const state of SUBTITLE_STATE_METRIC_LABELS) {
        subtitleStateRows.set({ state }, counts[state] ?? 0);
      }
    } catch (error) {
      logger.warn("Failed to sample subtitle state metrics:", error);
    }
  }

  private async processOne(): Promise<SubtitleTickOutcome> {
    await this.sampleStateMetrics();
    const job = await this.db.selectNextSubtitleJob();
    if (!job) return "no_job";

    const endJob = subtitleJobDurationSeconds.startTimer();
    subtitleActiveJobs.set(1);
    try {
      if (job.isDeleted || !job.bvid) {
        await this.db.updateSubtitleState(job.aid, "skipped");
        subtitleJobsTotal.inc({ outcome: "skipped" });
        subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
        return "skipped";
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
        subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
        return "skipped";
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

      const storedResult = await this.db.upsertSubtitlesBatch(subtitles);
      if (storedResult.insertedCount > 0) {
        subtitleTracksTotal.inc({ kind: "total" }, storedResult.insertedCount);
        subtitleTracksTotal.inc(
          { kind: "manual" },
          storedResult.insertedManualCount,
        );
        subtitleTracksTotal.inc({ kind: "ai" }, storedResult.insertedAiCount);
      }

      const nextState = anyManual
        ? "has_manual"
        : anyAi
          ? "ai_only"
          : "no_subtitle";
      await this.db.updateSubtitleState(job.aid, nextState);
      subtitleJobsTotal.inc({ outcome: nextState });
      subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
      return nextState;
    } catch (error) {
      const message = getErrorMessage(error);
      const failure = await this.db.recordSubtitleFailure(job.aid, message);
      const outcome =
        failure.state === "skipped" ? "skipped_after_retry" : "failed";
      subtitleJobsTotal.inc({ outcome });
      if (outcome === "skipped_after_retry") {
        subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
      }
      logger.error(
        `Subtitle job failed for aid=${job.aid} failure_count=${failure.failureCount}: ${message}`,
      );
      return outcome;
    } finally {
      subtitleActiveJobs.set(0);
      endJob();
    }
  }
}
