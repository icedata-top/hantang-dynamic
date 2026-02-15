import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randUA } from "@ahmedrangel/rand-user-agent";
import { config } from "../config";
import { logger } from "../utils/logger";

interface State {
  lastDynamicIdByType: Record<string, string>;
  lastUpdate: number;
  lastUA: string;
  biliTicket?: string;
  ticketExpiresAt?: number;
  imgKey?: string;
  subKey?: string;
  wbiKeysExpiresAt?: number;
  lastFollowingSync?: number; // ms timestamp
}

export class StateManager {
  private state: State;
  private filePath: string;

  constructor(filePath = "./state.json") {
    this.filePath = filePath;
    this.state = this.loadState();
  }

  private getDefaultState(): State {
    return {
      lastDynamicIdByType: {},
      lastUpdate: Date.now(),
      lastUA: randUA(),
    };
  }

  private loadState(): State {
    try {
      if (!existsSync(this.filePath)) {
        return this.getDefaultState();
      }

      const fileContent = readFileSync(this.filePath, "utf-8");
      if (!fileContent) {
        return this.getDefaultState();
      }

      const loadedState = JSON.parse(fileContent);

      // Migrate old format: lastDynamicId → lastDynamicIdByType["8"]
      const lastDynamicIdByType: Record<string, string> =
        loadedState.lastDynamicIdByType
          ? { ...loadedState.lastDynamicIdByType }
          : {};
      if (loadedState.lastDynamicId && !lastDynamicIdByType["8"]) {
        lastDynamicIdByType["8"] = loadedState.lastDynamicId.toString();
      }

      return {
        lastDynamicIdByType,
        lastUpdate: loadedState.lastUpdate ?? Date.now(),
        lastUA: loadedState.lastUA || randUA(),
        biliTicket: loadedState.biliTicket,
        ticketExpiresAt: loadedState.ticketExpiresAt,
        imgKey: loadedState.imgKey,
        subKey: loadedState.subKey,
        wbiKeysExpiresAt: loadedState.wbiKeysExpiresAt,
        lastFollowingSync: loadedState.lastFollowingSync,
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
      writeFileSync(
        this.filePath,
        JSON.stringify(this.state, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
    } catch (error) {
      logger.error("Error saving state:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
    }
  }

  getLastDynamicIdForType(type: number): bigint {
    const val = this.state.lastDynamicIdByType[String(type)];
    return val ? BigInt(val) : BigInt(0);
  }

  updateLastDynamicIdForType(type: number, id: bigint) {
    this.state.lastDynamicIdByType[String(type)] = id.toString();
    this.state.lastUpdate = Date.now();
    this.saveState();
  }

  get lastUA() {
    return this.state.lastUA;
  }

  get biliTicket() {
    return this.state.biliTicket;
  }

  get ticketExpiresAt() {
    return this.state.ticketExpiresAt;
  }

  get imgKey() {
    return this.state.imgKey;
  }

  get subKey() {
    return this.state.subKey;
  }

  get wbiKeysExpiresAt() {
    return this.state.wbiKeysExpiresAt;
  }

  updateUA() {
    this.state.lastUA = randUA();
    this.saveState();
    return this.state.lastUA;
  }

  isWithinHistoryWindow(timestamp: number) {
    const cutoff =
      Date.now() - config.application.maxHistoryDays * 86400 * 1000;
    return timestamp * 1000 > cutoff;
  }

  isTicketValid(): boolean {
    if (!this.state.biliTicket || !this.state.ticketExpiresAt) {
      return false;
    }
    return this.state.ticketExpiresAt - 3600 > Math.floor(Date.now() / 1000); // 1 hour buffer
  }

  isWbiKeysValid(): boolean {
    if (
      !this.state.imgKey ||
      !this.state.subKey ||
      !this.state.wbiKeysExpiresAt
    ) {
      return false;
    }
    return Date.now() / 1000 < this.state.wbiKeysExpiresAt;
  }

  updateTicket(ticket: string, expiresAt: number) {
    this.state.biliTicket = ticket;
    this.state.ticketExpiresAt = expiresAt;
    this.saveState();
  }

  updateWbiKeys(imgKey: string, subKey: string, expiresAt: number) {
    this.state.imgKey = imgKey;
    this.state.subKey = subKey;
    this.state.wbiKeysExpiresAt = expiresAt;
    this.saveState();
    logger.debug(
      `WBI keys updated, expires at: ${new Date(
        expiresAt * 1000,
      ).toLocaleString()}`,
    );
  }

  get lastFollowingSync(): number | undefined {
    return this.state.lastFollowingSync;
  }

  updateFollowingSync() {
    this.state.lastFollowingSync = Date.now();
    this.saveState();
  }
}
