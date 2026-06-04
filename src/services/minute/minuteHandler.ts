import { config } from "../../config";
import { Database } from "../../database";
import type { VideoMinuteSample } from "../../types/models/minute";
import { logger } from "../../utils/logger";
import { batchSampleVideoStats } from "./batchSampleVideoStats";

const MAX_SLEEP_MS = 60_000;
const MIN_SLEEP_MS = 100;

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
    logger.info("Adaptive minute handler started (dynamic sleep)");
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
   * Main loop: process due aids, then sleep until the next due time.
   * No fixed tick interval — wakes exactly when the next video is due.
   * Single-consumer by design — no row locking needed.
   */
  private async loop(signal: AbortSignal): Promise<void> {
    while (this.isRunning) {
      try {
        const processed = await this.tick();
        if (processed > 0) {
          continue;
        }

        const nextDue = await this.db.getNextMinuteDueAt();
        const now = Date.now();
        const waitMs = nextDue
          ? Math.max(
              Math.min(nextDue.getTime() - now, MAX_SLEEP_MS),
              MIN_SLEEP_MS,
            )
          : MAX_SLEEP_MS;
        await cancellableSleep(waitMs, signal);
      } catch (error) {
        logger.error("Minute handler loop error:", error);
        await cancellableSleep(5_000, signal);
      }
    }
    this.loopPromise = null;
  }

  private async tick(): Promise<number> {
    const due = await this.db.selectDueMinuteVideos(
      config.minute.claimBatchSize,
    );
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
