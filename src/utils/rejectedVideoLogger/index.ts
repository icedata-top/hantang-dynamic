import { config } from "../../config";
import { MySQLRejectedVideoLogger } from "./mysql";
import type { IRejectedVideoLogger } from "../rejectedVideoLogger";

/**
 * Create rejected video logger based on configuration
 */
export function createRejectedVideoLogger(): IRejectedVideoLogger {
  // Currently only MySQL is supported
  if (config.export.mysql.enabled) {
    return new MySQLRejectedVideoLogger();
  }

  throw new Error("MySQL export must be enabled for rejected video logging");
}
