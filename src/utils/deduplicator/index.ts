import { config } from "../../config";
import type { VideoData } from "../../core/types";
import { filterNewVideoDataMySQL } from "./mysql";

/**
 * Main deduplication function that checks all enabled exporters
 * @param videoData Array of video data to check for duplicates
 * @returns Promise<VideoData[]> Array of new videos not in any enabled database
 */
export async function filterNewVideoData(
  videoData: VideoData[],
): Promise<VideoData[]> {
  if (!videoData.length) {
    return videoData;
  }

  let filteredData = videoData;

  // Check MySQL if enabled
  if (config.export.mysql.enabled) {
    filteredData = await filterNewVideoDataMySQL(filteredData);
  }

  // TODO: Add DuckDB deduplication when implemented
  // if (config.export.duckdb.enabled) {
  //   filteredData = await filterNewVideoDataDuckDB(filteredData);
  // }

  // TODO: Add CSV deduplication when implemented
  // if (config.export.csv.enabled) {
  //   filteredData = await filterNewVideoDataCSV(filteredData);
  // }

  return filteredData;
}
