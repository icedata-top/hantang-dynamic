import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "./config";
import { randUA } from "@ahmedrangel/rand-user-agent";
import { logger } from "../utils/logger";

type AppState = {
  lastDynamicId: number;
  lastUpdate: number;
  lastUA: string;
};

export class StateManager {
  private state: AppState;
  private filePath: string;

  constructor(filePath = "./state.json") {
    this.filePath = filePath;
    this.state = this.loadState();
  }

  private getDefaultState(): AppState {
    return {
      lastDynamicId: 0,
      lastUpdate: Date.now(),
      lastUA: randUA(),
    };
  }

  private loadState(): AppState {
    try {
      if (!existsSync(this.filePath)) {
        return this.getDefaultState();
      }

      const fileContent = readFileSync(this.filePath, "utf-8");
      if (!fileContent) {
        return this.getDefaultState();
      }

      const loadedState = JSON.parse(fileContent) as Partial<AppState>;

      return {
        lastDynamicId: loadedState.lastDynamicId ?? 0,
        lastUpdate: loadedState.lastUpdate ?? Date.now(),
        lastUA: loadedState.lastUA || randUA(),
      };
    } catch (error) {
      logger.error("Error loading state:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return this.getDefaultState();
    }
  }

  saveState() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state));
    } catch (error) {
      logger.error("Error saving state:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
    }
  }

  get lastDynamicId() {
    return this.state.lastDynamicId;
  }

  get lastUA() {
    return this.state.lastUA;
  }

  updateUA() {
    this.state.lastUA = randUA();
    this.saveState();
    return this.state.lastUA;
  }

  updateLastDynamicId(id: number) {
    this.state.lastDynamicId = id;
    this.state.lastUpdate = Date.now();
    this.saveState();
  }

  isWithinHistoryWindow(timestamp: number) {
    const cutoff = Date.now() - config.MAX_HISTORY_DAYS * 86400 * 1000;
    return timestamp * 1000 > cutoff;
  }
}
