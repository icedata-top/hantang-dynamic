import type { VideoData } from "../../core/types";
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
