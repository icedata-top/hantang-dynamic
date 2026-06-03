import { config } from "../../config";
import { Database } from "../../database";
import type {
  VideoCollectionTask,
  VideoMinuteSample,
} from "../../types/models/minute";
import { logger } from "../../utils/logger";
import { batchSampleVideoStats } from "./batchSampleVideoStats";
import { MinutePoolBuilder } from "./poolBuilder";

function uniqueAids(tasks: VideoCollectionTask[]): bigint[] {
  return [...new Set(tasks.map((task) => task.aid.toString()))].map((aid) =>
    BigInt(aid),
  );
}

function mapTasksByAid(
  tasks: VideoCollectionTask[],
): Map<string, VideoCollectionTask[]> {
  const grouped = new Map<string, VideoCollectionTask[]>();
  for (const task of tasks) {
    const key = task.aid.toString();
    const existing = grouped.get(key) ?? [];
    existing.push(task);
    grouped.set(key, existing);
  }
  return grouped;
}

export class MinuteHandler {
  private db = Database.getInstance();
  private poolBuilder = new MinutePoolBuilder();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private gateRunning = false;

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
      const enqueuedMinute = await this.poolBuilder.enqueueDueMinuteTasks();
      if (enqueuedMinute > 0) {
        logger.info(
          `Minute handler enqueued minute tasks: minute=${enqueuedMinute}`,
        );
      }

      const tasks = await this.db.claimVideoCollectionTasks(
        config.minute.claimBatchSize,
        config.minute.lockDurationSeconds,
      );
      if (tasks.length > 0) {
        await this.processTasks(tasks);
      }

      void this.enqueueGateTasks();
    } catch (error) {
      logger.error("Minute handler tick failed:", error);
    } finally {
      this.running = false;
    }
  }

  private async enqueueGateTasks(): Promise<void> {
    if (this.gateRunning) {
      logger.debug(
        "Minute gate enqueue skipped because previous run is active",
      );
      return;
    }

    this.gateRunning = true;
    try {
      const enqueuedGate = await this.poolBuilder.enqueueGateTasks();
      if (enqueuedGate > 0) {
        logger.info(`Minute handler enqueued gate tasks: gate=${enqueuedGate}`);
      }
    } catch (error) {
      logger.error("Minute gate enqueue failed:", error);
    } finally {
      this.gateRunning = false;
    }
  }

  private async processTasks(tasks: VideoCollectionTask[]): Promise<void> {
    const tasksByAid = mapTasksByAid(tasks);
    const aids = uniqueAids(tasks);
    let samples: VideoMinuteSample[] = [];

    try {
      samples = await batchSampleVideoStats(aids, {
        batchSize: config.minute.batchSize,
      });
    } catch (error) {
      logger.error("Minute stats batch request failed:", error);
      await this.db.failVideoCollectionTasks(tasks.map((task) => task.id));
      return;
    }

    const sampledAidKeys = new Set(
      samples.map((sample) => sample.aid.toString()),
    );
    const successfulTaskIds = [...sampledAidKeys].flatMap((aid) =>
      (tasksByAid.get(aid) ?? []).map((task) => task.id),
    );
    const failedTaskIds = tasks
      .filter((task) => !sampledAidKeys.has(task.aid.toString()))
      .map((task) => task.id);

    if (samples.length > 0) {
      try {
        await this.db.insertVideoMinuteSamplesAndAck(
          samples,
          successfulTaskIds,
        );
      } catch (error) {
        logger.error("Minute sample write failed:", error);
        await this.db.failVideoCollectionTasks(tasks.map((task) => task.id));
        return;
      }
    }

    if (failedTaskIds.length > 0) {
      logger.warn(
        `Minute stats response missed ${failedTaskIds.length} task(s); leaving them on retry path`,
      );
      await this.db.failVideoCollectionTasks(failedTaskIds);
    }
  }
}
