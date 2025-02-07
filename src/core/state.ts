import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "./config";

type AppState = {
  lastDynamicId: number;
  lastUpdate: number;
};

export class StateManager {
  private state: AppState;
  private filePath: string;

  constructor(filePath = "./state.json") {
    this.filePath = filePath;
    this.state = this.loadState();
  }

  private loadState(): AppState {
    try {
      return existsSync(this.filePath)
        ? JSON.parse(readFileSync(this.filePath, "utf-8"))
        : { lastDynamicId: 0, lastUpdate: Date.now() };
    } catch (error) {
      console.error("Error loading state:", error);
      return { lastDynamicId: 0, lastUpdate: Date.now() };
    }
  }

  saveState() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state));
    } catch (error) {
      console.error("Error saving state:", error);
    }
  }

  get lastDynamicId() {
    return this.state.lastDynamicId;
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
