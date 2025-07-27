import type { BiliDynamicCard, VideoData } from "../../types";
import { logger } from "../logger";

/**
 * Filters out VideoData that already exist in the CSV file based on AID
 * TODO: Implement CSV deduplication
 * @param videoData Array of video data to check for duplicates
 * @returns Promise<VideoData[]> Array of new videos not in CSV file
 */
export async function filterNewVideoDataCSV(
  videoData: VideoData[],
): Promise<VideoData[]> {
  logger.debug("CSV deduplication not yet implemented, skipping");
  return videoData;
}

/**
 * Filters out BiliDynamicCard that already exist in the CSV file based on BVID
 * TODO: Implement CSV deduplication
 * @param dynamics Array of BiliDynamicCard to check for duplicates
 * @returns Promise<BiliDynamicCard[]> Array of new dynamics not in CSV file
 */
export async function filterNewDynamicsCSV(
  dynamics: BiliDynamicCard[],
): Promise<BiliDynamicCard[]> {
  logger.debug("CSV deduplication not yet implemented, skipping");
  return dynamics;
}
