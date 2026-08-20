import { config } from "../../config";
import { loadAccounts } from "../../core/account";
import { Database } from "../../database";
import {
  minuteBatchDurationSeconds,
  minuteBatchesTotal,
  minuteSamplesTotal,
} from "../../metrics/registry";
import type {
  CompleteVideoMinuteTuple,
  VideoMinuteSample,
} from "../../types/models/minute";
import { logger } from "../../utils/logger";
import { batchSampleVideoStats } from "./batchSampleVideoStats";
import { isCompleteVideoMinuteSample } from "./completeSample";
import { shouldPersistMinuteSample } from "./persistencePolicy";
import { startAutomaticWatchLaterManagement } from "./watchLaterReconciliation";

const MAX_SLEEP_MS = 60_000;
const MIN_SLEEP_MS = 100;
/** Non-gate videos wait at most this long before being flushed. */
const BATCH_TIMEOUT_MS = 30_000;

export type MinuteDatabase = Pick<
  Database,
  | "advanceFailedMinuteVideos"
  | "advanceUnchangedMinuteVideos"
  | "getWatchLaterAccounts"
  | "getDesiredWatchLaterSet"
  | "syncWatchLaterSnapshot"
  | "withWatchLaterAccountLease"
  | "getLatestCompleteVideoMinuteTuple"
  | "getNextMinuteDueAt"
  | "insertVideoMinuteSamples"
  | "selectDueMinuteVideos"
>;

export interface MinuteHandlerDependencies {
  database?: MinuteDatabase;
  loadAccounts?: typeof loadAccounts;
  sampleVideoStats?: typeof batchSampleVideoStats;
  startWatchLaterManagement?: typeof startAutomaticWatchLaterManagement;
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onDone = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onDone);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    signal.addEventListener("abort", onDone, { once: true });
    if (signal.aborted) onDone();
  });
}

export class MinuteHandler {
  private db: MinuteDatabase;
  private readonly accounts: typeof loadAccounts;
  private readonly sampleVideoStats: typeof batchSampleVideoStats;
  private readonly startWatchLaterManagement: typeof startAutomaticWatchLaterManagement;
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private watchLaterManagementPromise: Promise<void> | null = null;
  private readonly healthyWatchLaterAccountIds = new Set<bigint>();

  constructor(dependencies: MinuteHandlerDependencies = {}) {
    this.db = dependencies.database ?? Database.getInstance();
    this.accounts = dependencies.loadAccounts ?? loadAccounts;
    this.sampleVideoStats =
      dependencies.sampleVideoStats ?? batchSampleVideoStats;
    this.startWatchLaterManagement =
      dependencies.startWatchLaterManagement ??
      startAutomaticWatchLaterManagement;
  }

  start(): void {
    if (this.loopPromise) return;
    this.isRunning = true;
    this.healthyWatchLaterAccountIds.clear();
    this.abortController = new AbortController();
    this.loopPromise = this.loop(this.abortController.signal);
    this.watchLaterManagementPromise = this.runWatchLaterController(
      this.abortController.signal,
    );
    logger.info("Adaptive minute handler started (batch-accumulation)");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.abortController?.abort();
    logger.info("Adaptive minute handler stopping");
    if (this.loopPromise) {
      await this.loopPromise;
    }
    if (this.watchLaterManagementPromise) {
      await this.watchLaterManagementPromise;
    }
    this.abortController = null;
    logger.info("Adaptive minute handler stopped");
  }

  /**
   * Main loop with batch-accumulation.
   *
   * Non-gate videos are held until one of three flush triggers fires:
   *   1. A near-gate video appears among the due set
   *   2. The due set reaches {@link config.minute.claimBatchSize} (SELECT limit)
   *   3. The earliest pending video has been due for ≥ {@link BATCH_TIMEOUT_MS}
   *
   * Gate videos cause an immediate flush of the entire due set (including any
   * non-gate videos that have accumulated), so gate latency stays minimal.
   */
  private async loop(signal: AbortSignal): Promise<void> {
    while (this.isRunning) {
      try {
        const due = await this.db.selectDueMinuteVideos(
          config.minute.claimBatchSize,
        );

        // ── Nothing due — sleep until the next video becomes due ──
        if (due.length === 0) {
          const nextDue = await this.db.getNextMinuteDueAt();
          const now = Date.now();
          const waitMs = nextDue
            ? Math.max(
                Math.min(nextDue.getTime() - now, MAX_SLEEP_MS),
                MIN_SLEEP_MS,
              )
            : MAX_SLEEP_MS;
          await cancellableSleep(waitMs, signal);
          continue;
        }

        // ── Evaluate flush triggers ──
        const hasGate = due.some((d) => d.nearGate);
        const isFull = due.length >= config.minute.claimBatchSize;
        const earliestDueAt = Math.min(...due.map((d) => d.dueAt.getTime()));
        const waitedLongEnough = Date.now() - earliestDueAt >= BATCH_TIMEOUT_MS;

        if (hasGate || isFull || waitedLongEnough) {
          const trigger = hasGate ? "gate" : isFull ? "full" : "timeout";
          minuteBatchesTotal.inc({ trigger });
          if (hasGate) {
            logger.debug(`Minute batch flush: gate (${due.length} video(s))`);
          } else if (isFull) {
            logger.debug(
              `Minute batch flush: full batch (${due.length} video(s))`,
            );
          } else {
            logger.debug(
              `Minute batch flush: timeout (${due.length} video(s), ` +
                `waited ${Math.round((Date.now() - earliestDueAt) / 1000)}s)`,
            );
          }

          await this.processBatch(due);
          // Immediately re-check — there may be more due videos.
          continue;
        }

        // ── Not ready to flush — sleep until timeout or next due ──
        const timeUntilTimeout =
          BATCH_TIMEOUT_MS - (Date.now() - earliestDueAt);
        const nextFutureDue = await this.db.getNextMinuteDueAt();

        let sleepMs = timeUntilTimeout;
        if (nextFutureDue) {
          const timeUntilNextDue = nextFutureDue.getTime() - Date.now();
          if (timeUntilNextDue > 0 && timeUntilNextDue < sleepMs) {
            sleepMs = timeUntilNextDue;
          }
        }

        sleepMs = Math.max(Math.min(sleepMs, MAX_SLEEP_MS), MIN_SLEEP_MS);
        await cancellableSleep(sleepMs, signal);
      } catch (error) {
        logger.error("Minute handler loop error:", error);
        await cancellableSleep(5_000, signal);
      }
    }
    this.loopPromise = null;
  }

  private async runWatchLaterController(signal: AbortSignal): Promise<void> {
    while (this.isRunning) {
      const startedAt = Date.now();
      try {
        const run = await this.startWatchLaterManagement(
          this.db,
          this.accounts(),
          undefined,
          {
            shouldContinue: () => this.isRunning,
            onHealthyAccounts: (accountIds) => {
              this.healthyWatchLaterAccountIds.clear();
              for (const accountId of accountIds) {
                this.healthyWatchLaterAccountIds.add(accountId);
              }
            },
          },
        );
        await this.observeWatchLaterConvergence(run);
      } catch (error) {
        logger.error("Watch-later management failed:", error);
      }
      const nextDelay = Math.max(0, 15 * 60_000 - (Date.now() - startedAt));
      await cancellableSleep(nextDelay, signal);
    }
  }

  private async observeWatchLaterConvergence(managementRun: {
    convergence: Promise<unknown>;
  }): Promise<void> {
    try {
      await managementRun.convergence;
      logger.info("Watch Later reconciliation cycle completed");
    } catch (error) {
      logger.error("Watch Later background convergence failed:", error);
    }
  }

  /**
   * Fetch complete stats for due videos, then persist samples that meet the
   * counter-aware minute policy and advance all remaining valid coverage.
   */
  async processBatch(
    due: {
      aid: bigint;
      lastView: bigint | null;
      watchLaterManagedAccountIds: bigint[];
    }[],
  ): Promise<number> {
    if (due.length === 0) return 0;
    const endBatch = minuteBatchDurationSeconds.startTimer();

    const aids = due.map((d) => d.aid);
    let samples: VideoMinuteSample[] = [];
    try {
      const accounts = this.accounts();
      const observedWatchLaterAccountIdsByAid = new Map(
        due.map(
          (item) =>
            [item.aid.toString(), item.watchLaterManagedAccountIds] as const,
        ),
      );
      try {
        samples = await this.sampleVideoStats(aids, {
          batchSize: config.minute.batchSize,
          toViewAccounts: accounts,
          observedWatchLaterAccountIdsByAid,
          healthyWatchLaterAccountIds: this.healthyWatchLaterAccountIds,
        });
      } catch (error) {
        logger.error("Minute stats batch request failed:", error);
        minuteSamplesTotal.inc({ outcome: "failed" }, aids.length);
        await this.db.advanceFailedMinuteVideos(aids);
        return aids.length;
      }

      const changed: VideoMinuteSample[] = [];
      const unchangedAids: bigint[] = [];
      const samplesByAid = new Map<string, CompleteVideoMinuteTuple>();
      const invalidAids = new Set<string>();

      for (const sample of samples) {
        const key = sample.aid.toString();
        if (!isCompleteVideoMinuteSample(sample)) {
          invalidAids.add(key);
          continue;
        }
        if (samplesByAid.has(key)) {
          invalidAids.add(key);
          continue;
        }
        samplesByAid.set(key, sample);
      }

      for (const [key, sample] of samplesByAid) {
        if (invalidAids.has(key)) continue;
        const previous = await this.db.getLatestCompleteVideoMinuteTuple(
          sample.aid,
        );
        if (shouldPersistMinuteSample(previous, sample)) {
          changed.push(sample);
        } else {
          unchangedAids.push(sample.aid);
        }
      }

      const failedAids = aids.filter(
        (aid) =>
          !samplesByAid.has(aid.toString()) || invalidAids.has(aid.toString()),
      );

      if (changed.length > 0) {
        try {
          await this.db.insertVideoMinuteSamples(changed);
        } catch (error) {
          logger.error("Minute sample write failed:", error);
          minuteSamplesTotal.inc({ outcome: "failed" }, aids.length);
          await this.db.advanceFailedMinuteVideos(aids);
          return aids.length;
        }
      }

      if (unchangedAids.length > 0) {
        await this.db.advanceUnchangedMinuteVideos(unchangedAids);
      }

      if (failedAids.length > 0) {
        logger.warn(`Minute stats response missed ${failedAids.length} aid(s)`);
        await this.db.advanceFailedMinuteVideos(failedAids);
      }

      if (changed.length > 0) {
        minuteSamplesTotal.inc({ outcome: "changed" }, changed.length);
      }
      if (unchangedAids.length > 0) {
        minuteSamplesTotal.inc({ outcome: "unchanged" }, unchangedAids.length);
      }
      if (failedAids.length > 0) {
        minuteSamplesTotal.inc({ outcome: "failed" }, failedAids.length);
      }

      return aids.length;
    } finally {
      endBatch();
    }
  }
}
