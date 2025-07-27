import mysql from "mysql2/promise";
import { config } from "../../config";
import type { BiliDynamicCard, VideoData } from "../../core/types";
import { logger } from "../logger";

/**
 * Filters out BiliDynamicCard that already exist in the MySQL database based on BVID
 * This runs BEFORE processing to save CPU and API calls
 * @param dynamics Array of dynamic cards to check for duplicates
 * @returns Promise<BiliDynamicCard[]> Array of new dynamics not in database
 */
export async function filterNewDynamicsMySQL(
  dynamics: BiliDynamicCard[],
): Promise<BiliDynamicCard[]> {
  if (!dynamics.length) {
    return dynamics;
  }

  if (!isMySQLConfigured()) {
    logger.debug("MySQL not properly configured, skipping MySQL deduplication");
    return dynamics;
  }

  try {
    const connection = await mysql.createConnection({
      host: config.export.mysql.host,
      port: config.export.mysql.port,
      user: config.export.mysql.username,
      password: config.export.mysql.password,
      database: config.export.mysql.database,
    });

    const bvids = dynamics.map((dynamic) => dynamic.desc.bvid).filter(Boolean);
    if (bvids.length === 0) {
      await connection.end();
      return dynamics;
    }

    const table = config.export.mysql.table;

    // Query existing BVIDs from database
    const placeholders = bvids.map(() => "?").join(",");
    const query = `SELECT bvid FROM \`${table}\` WHERE bvid IN (${placeholders})`;

    const [rows] = await connection.execute(query, bvids);
    await connection.end();

    // Extract existing BVIDs from query result
    const existingBvids = new Set(
      (rows as { bvid: string }[]).map((row) => row.bvid),
    );

    // Filter out dynamics that already exist in database
    const newDynamics = dynamics.filter(
      (dynamic) => !existingBvids.has(dynamic.desc.bvid),
    );

    logger.info(
      `MySQL BVID deduplication: ${dynamics.length} total, ${existingBvids.size} duplicates, ${newDynamics.length} new dynamics`,
    );

    return newDynamics;
  } catch (error) {
    logger.error(
      "MySQL BVID deduplication failed, proceeding with all dynamics:",
      error,
    );
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return dynamics;
  }
}

/**
 * Filters out VideoData that already exist in the MySQL database based on AID
 * @param videoData Array of video data to check for duplicates
 * @returns Promise<VideoData[]> Array of new videos not in database
 */
export async function filterNewVideoDataMySQL(
  videoData: VideoData[],
): Promise<VideoData[]> {
  if (!videoData.length) {
    return videoData;
  }

  if (!isMySQLConfigured()) {
    logger.debug("MySQL not properly configured, skipping MySQL deduplication");
    return videoData;
  }

  try {
    const connection = await mysql.createConnection({
      host: config.export.mysql.host,
      port: config.export.mysql.port,
      user: config.export.mysql.username,
      password: config.export.mysql.password,
      database: config.export.mysql.database,
    });

    const aids = videoData.map((video) => video.aid);
    const table = config.export.mysql.table;

    // Query existing AIDs from database
    const placeholders = aids.map(() => "?").join(",");
    const query = `SELECT aid FROM \`${table}\` WHERE aid IN (${placeholders})`;

    const [rows] = await connection.execute(query, aids);
    await connection.end();

    // Extract existing AIDs from query result
    const existingAids = new Set(
      (rows as { aid: bigint }[]).map((row) => row.aid.toString()),
    );

    // Filter out videos that already exist in database
    const newVideos = videoData.filter(
      (video) => !existingAids.has(video.aid.toString()),
    );

    logger.info(
      `MySQL deduplication: ${videoData.length} total, ${existingAids.size} duplicates, ${newVideos.length} new videos`,
    );

    return newVideos;
  } catch (error) {
    logger.error(
      "MySQL deduplication failed, proceeding with all videos:",
      error,
    );
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return videoData;
  }
}

/**
 * Check if MySQL is properly configured for deduplication
 */
function isMySQLConfigured(): boolean {
  return !!(
    config.export.mysql.host &&
    config.export.mysql.port &&
    config.export.mysql.username &&
    config.export.mysql.password &&
    config.export.mysql.table &&
    config.export.mysql.database
  );
}
