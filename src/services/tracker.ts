import { fetchDynamics } from "../api/dynamic";
import { generateBiliTicket } from "../api/signatures/biliTicket";
import { config } from "../config";
import { StateManager } from "../core/state";
import type { BiliDynamicCard } from "../types";
import { sleep } from "../utils/datetime";
import { filterAndProcessDynamics } from "../utils/dynamic";
import { exportData } from "../utils/exporter/exporter";
import { logger } from "../utils/logger";
import { notifyNewVideos } from "../utils/notifier/notifier";

export class DynamicTracker {
  private state = new StateManager();
  private isRunning = false;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const stateManager = new StateManager();
    if (!stateManager.isTicketValid()) {
      logger.debug("Generating initial BiliTicket...");
      const ticketData = await generateBiliTicket();
      if (ticketData) {
        stateManager.updateTicket(ticketData.ticket, ticketData.expiresAt);
        logger.info("BiliTicket initialized successfully");
      } else {
        logger.debug("Failed to initialize BiliTicket, continuing without it");
      }
    } else {
      logger.debug("Using existing valid BiliTicket");
    }

    while (this.isRunning) {
      try {
        await this.checkDynamics();
        await sleep(config.application.fetchInterval);
      } catch (error) {
        logger.error("Tracker error:", error);
        if (error instanceof Error) {
          logger.error(error.stack);
        }
        this.state.updateUA();
        await sleep(3600);
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  private async checkDynamics() {
    let maxDynamicId = this.state.lastDynamicId;

    await fetchDynamics({
      minDynamicId: this.state.lastDynamicId,
      minTimestamp:
        Date.now() / 1000 - config.application.maxHistoryDays * 86400,
      max_items: config.application.maxItem,
      types: ["video", "forward"],
      onPage: async (dynamics: BiliDynamicCard[]) => {
        const videoData = await filterAndProcessDynamics(dynamics);
        if (videoData.length) {
          exportData(videoData);
          await notifyNewVideos(videoData);
        }
        maxDynamicId = Math.max(
          maxDynamicId,
          ...dynamics.map((d) => Number(d.desc.dynamic_id)),
        );
      },
    });

    if (maxDynamicId > this.state.lastDynamicId) {
      this.state.updateLastDynamicId(maxDynamicId);
    }
  }
}
