import { isAccountAuthError } from "../api/client";
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
  subtitleTicksTotal,
  subtitleTracksTotal,
} from "../metrics/registry";
import {
  type BiliSubtitleStyle,
  isAiSubtitle,
  isManualSubtitle,
} from "../types/bilibili/subtitle.js";
import { logger } from "../utils/logger";

const NO_JOB_IDLE_SLEEP_MS = 10 * 60 * 1000;

type SubtitleTickOutcome =
  | "no_job"
  | "skipped"
  | "has_manual"
  | "partial_manual"
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
  private readonly accounts: AccountContext[];
  private accountIndex = 0;
  private disabledAccountUids = new Set<string>();
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(accounts: AccountContext[]) {
    if (accounts.length === 0) {
      throw new Error("SubtitleService requires at least one account");
    }
    this.accounts = accounts;
  }

  private get account(): AccountContext {
    return this.accounts[this.accountIndex];
  }

  private get enabledAccounts(): AccountContext[] {
    return this.accounts.filter(
      (account) => !this.disabledAccountUids.has(account.uid || "unknown"),
    );
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
      let sleepMs = config.subtitle.fetchIntervalMs;
      try {
        subtitleLastTickTimestampSeconds.set(Date.now() / 1000);
        const outcome = await this.processOne();
        this.recordTick(outcome);
        if (outcome === "no_job") {
          sleepMs = Math.max(
            config.subtitle.fetchIntervalMs,
            NO_JOB_IDLE_SLEEP_MS,
          );
        }
      } catch (error) {
        this.recordTick("error");
        logger.error("Subtitle service loop error:", error);
      }

      await cancellableSleep(sleepMs, signal);
    }

    this.loopPromise = null;
  }

  private recordTick(outcome: SubtitleTickOutcome): void {
    subtitleTicksTotal.inc({ outcome });
  }

  private nextEnabledAccount(): AccountContext | null {
    if (this.disabledAccountUids.size >= this.accounts.length) return null;

    for (let offset = 1; offset <= this.accounts.length; offset++) {
      const index = (this.accountIndex + offset) % this.accounts.length;
      const account = this.accounts[index];
      if (!this.disabledAccountUids.has(account.uid || "unknown")) {
        this.accountIndex = index;
        return account;
      }
    }

    return null;
  }

  private async disableCurrentAccount(error: Error): Promise<boolean> {
    const account = this.account;
    const uid = account.uid || "unknown";
    if (!this.disabledAccountUids.has(uid)) {
      this.disabledAccountUids.add(uid);
      const message =
        `[uid=${uid}] Subtitle account auth failed; disabling this account for subtitle jobs.\n` +
        `${error.message}`;
      logger.error(message);
    }

    const nextAccount = this.nextEnabledAccount();
    if (!nextAccount) {
      logger.error("All subtitle accounts are disabled by auth failures");
      return false;
    }

    logger.warn(
      `[uid=${uid}] Switching subtitle service to uid=${nextAccount.uid || "unknown"}`,
    );
    return true;
  }

  private async processOne(): Promise<SubtitleTickOutcome> {
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

      while (this.enabledAccounts.length > 0) {
        try {
          const outcome = await this.processJobWithCurrentAccount(
            job.aid,
            job.bvid,
          );
          return outcome;
        } catch (error) {
          if (isAccountAuthError(error)) {
            const switched = await this.disableCurrentAccount(error);
            if (switched) continue;
          }
          throw error;
        }
      }

      throw new Error("All subtitle accounts are disabled by auth failures");
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

  private async processJobWithCurrentAccount(
    aid: bigint,
    jobBvid: string,
  ): Promise<SubtitleTickOutcome> {
    const view = await fetchSubtitleVideoView(
      this.account.webInterfaceClient,
      aid,
    );
    if (!view) {
      await this.db.updateSubtitleState(aid, "skipped");
      subtitleJobsTotal.inc({ outcome: "skipped" });
      subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
      return "skipped";
    }

    const bvid = view.bvid || jobBvid;
    let allPagesHaveManual = view.pages.length > 0;
    let anyManual = false;
    let anyAi = false;
    const subtitles: UpsertSubtitleInput[] = [];

    for (const page of view.pages) {
      let pageHasManual = await this.db.cidHasManualSubtitle(aid, page.cid);
      anyManual = anyManual || pageHasManual;
      anyAi = anyAi || (await this.db.cidHasAiSubtitle(aid, page.cid));
      if (pageHasManual) {
        continue;
      }

      const tracks = await fetchPlayerSubtitleTracks(
        this.account.playerClient,
        bvid,
        page.cid,
      );
      for (const track of tracks) {
        if (!track.subtitle_url) continue;

        const subtitleJson = await fetchSubtitleJson(track.subtitle_url);
        if (isManualSubtitle(track)) {
          pageHasManual = true;
          anyManual = true;
        }
        if (isAiSubtitle(track)) anyAi = true;

        subtitles.push({
          aid,
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
      if (!pageHasManual) allPagesHaveManual = false;
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

    const nextState = allPagesHaveManual
      ? "has_manual"
      : anyManual
        ? "partial_manual"
        : anyAi
          ? "ai_only"
          : "no_subtitle";
    await this.db.updateSubtitleState(aid, nextState);
    subtitleJobsTotal.inc({ outcome: nextState });
    subtitleLastTerminalJobTimestampSeconds.set(Date.now() / 1000);
    return nextState;
  }
}
