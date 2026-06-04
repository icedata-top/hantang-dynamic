import { config } from "../../config";
import { Database } from "../../database";
import type { VideoMinuteSample } from "../../types/models/minute";
import { logger } from "../../utils/logger";
import { batchSampleVideoStats } from "./batchSampleVideoStats";

export class MinuteHandler {
  private db = Database.getInstance();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      config.minute.consumerTickMs,
    );
    void this.tick();
    logger.info("Adaptive minute handler started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Adaptive minute handler stopped");
  }

  async tick(): Promise<void> {
    if (this.running) {
      logger.debug(
        "Minute handler tick skipped because previous tick is active",
      );
      return;
    }

    this.running = true;
    try {
      // Query state table directly — no queue intermediary
      const aids = await this.db.selectDueMinuteVideos(
        config.minute.claimBatchSize,
      );
      if (aids.length === 0) return;

      let samples: VideoMinuteSample[] = [];
      try {
        samples = await batchSampleVideoStats(aids, {
          batchSize: config.minute.batchSize,
        });
      } catch (error) {
        logger.error("Minute stats batch request failed:", error);
        await this.db.advanceFailedMinuteVideos(aids);
        return;
      }

      const sampledAidSet = new Set(
        samples.map((sample) => sample.aid.toString()),
      );
      const failedAids = aids.filter(
        (aid) => !sampledAidSet.has(aid.toString()),
      );

      if (samples.length > 0) {
        try {
          // INSERT into video_minute fires trigger which:
          //   - advances next_minute_due_at
          //   - updates last_view
          //   - detects gate crossings → writes to gate_crossings
          //   - boosts priority when near a gate
          await this.db.insertVideoMinuteSamples(samples);
        } catch (error) {
          logger.error("Minute sample write failed:", error);
          await this.db.advanceFailedMinuteVideos(aids);
          return;
        }
      }

      if (failedAids.length > 0) {
        logger.warn(
          `Minute stats response missed ${failedAids.length} aid(s); advancing to next cycle`,
        );
        await this.db.advanceFailedMinuteVideos(failedAids);
      }
    } catch (error) {
      logger.error("Minute handler tick failed:", error);
    } finally {
      this.running = false;
    }
  }
}
