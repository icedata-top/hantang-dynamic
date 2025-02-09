import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "./config";
import { randUserAgent } from "@tonyrl/rand-user-agent";

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
      lastUA: randUserAgent("desktop"),
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
        lastUA: loadedState.lastUA || randUserAgent("desktop"),
      };
    } catch (error) {
      console.error("Error loading state:", error);
      return this.getDefaultState();
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

  get lastUA() {
    return this.state.lastUA;
  }

  updateUA() {
    this.state.lastUA = randUserAgent("desktop");
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
