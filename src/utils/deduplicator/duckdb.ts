import type { BiliDynamicCard, VideoData } from "../../core/types";
import { logger } from "../logger";

/**
 * Filters out VideoData that already exist in the DuckDB database based on AID
 * TODO: Implement DuckDB deduplication
 * @param videoData Array of video data to check for duplicates
 * @returns Promise<VideoData[]> Array of new videos not in database
 */
export async function filterNewVideoDataDuckDB(
  videoData: VideoData[],
): Promise<VideoData[]> {
  logger.debug("DuckDB deduplication not yet implemented, skipping");
  return videoData;
}

/**
 * Filters out BiliDynamicCard that already exist in the DuckDB database based on BVID
 * TODO: Implement DuckDB deduplication
 * @param dynamics Array of BiliDynamicCard to check for duplicates
 * @returns Promise<BiliDynamicCard[]> Array of new dynamics not in database
 */
export async function filterNewDynamicsDuckDB(
  dynamics: BiliDynamicCard[],
): Promise<BiliDynamicCard[]> {
  logger.debug("DuckDB deduplication not yet implemented, skipping");
  return dynamics;
}
