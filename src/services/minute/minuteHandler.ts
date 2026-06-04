import { config } from "../../config";
import { Database } from "../../database";
import type { VideoMinuteSample } from "../../types/models/minute";
import { logger } from "../../utils/logger";
import { batchSampleVideoStats } from "./batchSampleVideoStats";

const MAX_SLEEP_MS = 60_000;
const MIN_SLEEP_MS = 100;
/** Non-gate videos wait at most this long before being flushed. */
const BATCH_TIMEOUT_MS = 30_000;

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
  private db = Database.getInstance();
  private isRunning = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  start(): void {
    if (this.loopPromise) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.loopPromise = this.loop(this.abortController.signal);
    logger.info("Adaptive minute handler started (batch-accumulation)");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.abortController?.abort();
    logger.info("Adaptive minute handler stopping");
    if (this.loopPromise) {
      await this.loopPromise;
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
   *   3. The earliest pending video is overdue by ≥ {@link BATCH_TIMEOUT_MS}
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
        const overdueLongEnough =
          Date.now() - earliestDueAt >= BATCH_TIMEOUT_MS;

        if (hasGate || isFull || overdueLongEnough) {
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

  /**
   * Fetch stats for a pre-selected set of due videos, diff against last_view,
   * then insert changed samples / advance unchanged / mark failed.
   */
  private async processBatch(
    due: { aid: bigint; lastView: bigint | null }[],
  ): Promise<number> {
    if (due.length === 0) return 0;

    const aids = due.map((d) => d.aid);
    const lastViewByAid = new Map(
      due.map((d) => [d.aid.toString(), d.lastView]),
    );

    let samples: VideoMinuteSample[] = [];
    try {
      samples = await batchSampleVideoStats(aids, {
        batchSize: config.minute.batchSize,
      });
    } catch (error) {
      logger.error("Minute stats batch request failed:", error);
      await this.db.advanceFailedMinuteVideos(aids);
      return aids.length;
    }

    const changed: VideoMinuteSample[] = [];
    const unchangedAids: bigint[] = [];
    const sampledAidSet = new Set<string>();

    for (const sample of samples) {
      const key = sample.aid.toString();
      // Skip samples with missing view — inserting NULL view would overwrite
      // last_view and break near-gate scheduling. Let it fall to failedAids.
      if (sample.view === null || sample.view === undefined) {
        continue;
      }
      sampledAidSet.add(key);
      const prev = lastViewByAid.get(key);
      if (prev === null || prev === undefined || BigInt(sample.view) !== prev) {
        changed.push(sample);
      } else {
        unchangedAids.push(sample.aid);
      }
    }

    const failedAids = aids.filter((aid) => !sampledAidSet.has(aid.toString()));

    if (changed.length > 0) {
      try {
        await this.db.insertVideoMinuteSamples(changed);
      } catch (error) {
        logger.error("Minute sample write failed:", error);
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

    return aids.length;
  }
}
