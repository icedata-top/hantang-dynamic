import { StateManager } from "../core/state";
import { fetchDynamics } from "../api/dynamic";
import { exportData } from "../utils/exporter";
import { processCard } from "../utils/helpers";
import { config } from "../core/config";
import { sleep } from "../utils/datetime";
import type { BiliDynamicCard, VideoData } from "../core/types";

export class DynamicTracker {
  private state = new StateManager();
  private isRunning = false;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      try {
        await this.checkDynamics();
        await sleep(config.FETCH_INTERVAL);
      } catch (error) {
        console.error("Tracker error:", error);
        await sleep(3600);
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  private async checkDynamics() {
    const Dynamics = await fetchDynamics({
      minDynamicId: this.state.lastDynamicId,
      minTimestamp: Date.now() / 1000 - config.MAX_HISTORY_DAYS * 86400,
      types: ["video"],
    });

    if (Dynamics.length) {
      await this.processDynamics(Dynamics);
      this.state.updateLastDynamicId(
        Math.max(...Dynamics.map((d) => d.desc.dynamic_id)),
      );
    }
  }

  private async processDynamics(dynamics: BiliDynamicCard[]) {
    let videoData = [] as VideoData[];
    dynamics = dynamics.filter(
      (dynamic, index, self) =>
        index === self.findIndex((t) => t.desc.bvid === dynamic.desc.bvid),
    );
    console.log(`Processing ${dynamics.length} dynamics`);

    for (const dynamic of dynamics) {
      const processedData = await processCard(dynamic);
      if (!processedData) continue;
      console.log(`Processed ${processedData.bvid}: ${processedData.title}`);
      videoData.push(processedData);
    }

    if (dynamics.length) {
      exportData(videoData);
    }
  }
}
