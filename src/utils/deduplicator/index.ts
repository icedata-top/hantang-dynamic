import { config } from "../../config";
import type { BiliDynamicCard, VideoData } from "../../types";
import { filterNewDynamicsMySQL, filterNewVideoDataMySQL } from "./mysql";

/**
 * Early deduplication function that checks dynamics before processing
 * This saves significant CPU and API processing time
 * @param dynamics Array of dynamic cards to check for duplicates
 * @returns Promise<BiliDynamicCard[]> Array of new dynamics not in any enabled database
 */
export async function filterNewDynamics(
  dynamics: BiliDynamicCard[],
): Promise<BiliDynamicCard[]> {
  if (!dynamics.length) {
    return dynamics;
  }

  let filteredDynamics = dynamics;

  // Check MySQL if enabled
  if (config.export.mysql.enabled) {
    filteredDynamics = await filterNewDynamicsMySQL(filteredDynamics);
  }

  // TODO: Add DuckDB early deduplication when implemented
  // if (config.export.duckdb.enabled) {
  //   filteredDynamics = await filterNewDynamicsDuckDB(filteredDynamics);
  // }

  // TODO: Add CSV early deduplication when implemented
  // if (config.export.csv.enabled) {
  //   filteredDynamics = await filterNewDynamicsCSV(filteredDynamics);
  // }

  return filteredDynamics;
}

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
