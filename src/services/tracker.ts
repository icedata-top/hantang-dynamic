import { StateManager } from "../core/state";
import { fetchDynamics } from "../api/dynamic";
import { exportData } from "../utils/exporter/exporter";
import { config } from "../core/config";
import { sleep } from "../utils/datetime";
import { logger } from "../utils/logger";
import { filterAndProcessDynamics } from "../utils/dynamic";
import { generateBiliTicket } from "../api/signatures/biliTicket";
import type { BiliDynamicCard } from "../core/types";

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
        await sleep(config.FETCH_INTERVAL);
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
    const Dynamics = await fetchDynamics({
      minDynamicId: this.state.lastDynamicId,
      minTimestamp: Date.now() / 1000 - config.MAX_HISTORY_DAYS * 86400,
      max_items: config.MAX_ITEM,
      types: ["video", "forward"],
    });

    if (Dynamics.length) {
      await this.processDynamics(Dynamics);
      this.state.updateLastDynamicId(
        Math.max(...Dynamics.map((d) => Number(d.desc.dynamic_id))),
      );
    }
  }

  private async processDynamics(dynamics: BiliDynamicCard[]) {
    const videoData = await filterAndProcessDynamics(dynamics);
    if (videoData.length) {
      exportData(videoData);
    }
  }
}
