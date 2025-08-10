import { config } from "../config";
import type { VideoData } from "../types";
import { logger } from "./logger";

/**
 * Represents a rejected video entry in the database
 */
export interface RejectedVideo {
  bvid: string;
  aid: bigint;
  title: string;
  rejectedAt: Date;
  reason: string;
}

/**
 * Reasons why a video might be rejected
 */
export enum RejectionReason {
  CONTENT_BLACKLIST = "content_blacklist",
  CONTENT_WHITELIST = "content_whitelist",
  TYPE_ID_FILTER = "type_id_filter",
  COPYRIGHT_FILTER = "copyright_filter",
  RELATED_QUALITY_FILTER = "related_quality_filter",
  SECONDARY_QUALITY_FILTER = "secondary_quality_filter",
  USER_FILTER = "user_filter",
  OTHER = "other",
}

/**
 * Interface for rejected video logger implementations
 */
export interface IRejectedVideoLogger {
  /**
   * Check if a video has been rejected before
   */
  isRejected(bvid: string): Promise<boolean>;

  /**
   * Log a rejected video to the database
   */
  logRejectedVideo(video: VideoData, reason: RejectionReason): Promise<void>;

  /**
   * Initialize the rejected videos table if it doesn't exist
   */
  initializeTable(): Promise<void>;

  /**
   * Clean up old rejected video records (optional, for maintenance)
   */
  cleanupOldRecords?(olderThanDays: number): Promise<number>;
}

/**
 * Factory function to create the appropriate rejected video logger based on configuration
 */
export function createRejectedVideoLogger(): IRejectedVideoLogger | null {
  // Check MySQL first
  if (
    config.export.mysql.enabled &&
    config.export.mysql.host &&
    config.export.mysql.database
  ) {
    // We'll implement MySQLRejectedVideoLogger
    const { MySQLRejectedVideoLogger } = require("./rejectedVideoLogger/mysql");
    return new MySQLRejectedVideoLogger();
  }

  // Then check DuckDB
  if (config.export.duckdb.enabled && config.export.duckdb.path) {
    // We'll implement DuckDBRejectedVideoLogger
    const {
      DuckDBRejectedVideoLogger,
    } = require("./rejectedVideoLogger/duckdb");
    return new DuckDBRejectedVideoLogger();
  }

  // No valid export configuration found
  logger.debug(
    "No valid database export configuration found for rejected video logging. " +
      "Rejected video logging will be disabled.",
  );
  return null;
}

/**
 * Singleton instance of the rejected video logger
 */
let rejectedVideoLogger: IRejectedVideoLogger | null = null;

/**
 * Get the singleton instance of the rejected video logger
 */
export function getRejectedVideoLogger(): IRejectedVideoLogger | null {
  if (rejectedVideoLogger === null) {
    rejectedVideoLogger = createRejectedVideoLogger();
  }
  return rejectedVideoLogger;
}

/**
 * Convenience function to check if a video is rejected
 */
export async function isVideoRejected(bvid: string): Promise<boolean> {
  const rejectedLogger = getRejectedVideoLogger();
  if (!rejectedLogger) {
    return false; // If no logger available, assume not rejected
  }

  try {
    return await rejectedLogger.isRejected(bvid);
  } catch (error) {
    logger.warn(`Failed to check if video ${bvid} is rejected:`, error);
    return false; // On error, assume not rejected to avoid blocking processing
  }
}

/**
 * Convenience function to log a rejected video
 */
export async function logRejectedVideo(
  video: VideoData,
  reason: RejectionReason,
): Promise<void> {
  const rejectedLogger = getRejectedVideoLogger();
  if (!rejectedLogger) {
    return; // If no logger available, silently skip
  }

  try {
    await rejectedLogger.logRejectedVideo(video, reason);
    logger.debug(
      `Logged rejected video: ${video.bvid} (${video.title}) - Reason: ${reason}`,
    );
  } catch (error) {
    logger.warn(`Failed to log rejected video ${video.bvid}:`, error);
    // Don't throw error to avoid breaking the main processing flow
  }
}
