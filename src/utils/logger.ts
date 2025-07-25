import { config } from "../config";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private currentLevel: number;

  constructor() {
    this.currentLevel =
      LOG_LEVELS[config.app.logLevel as LogLevel] || LOG_LEVELS.info;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.currentLevel;
  }

  private formatMessage(message: any): string {
    if (typeof message === "string") return message;
    return JSON.stringify(message);
  }

  debug(...args: any[]): void {
    if (this.shouldLog("debug")) {
      console.log(`[DEBUG] ${args.map(this.formatMessage).join(" ")}`);
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog("info")) {
      console.log(`[INFO] ${args.map(this.formatMessage).join(" ")}`);
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog("warn")) {
      console.warn(`[WARN] ${args.map(this.formatMessage).join(" ")}`);
    }
  }

  error(...args: any[]): void {
    if (this.shouldLog("error")) {
      console.error(`[ERROR] ${args.map(this.formatMessage).join(" ")}`);
    }
  }
}

export const logger = new Logger();
