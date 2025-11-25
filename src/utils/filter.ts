import { config } from "../config";
import type { VideoData } from "../types";
import { logger } from "./logger";

export const filterVideo = async (
  videoData: VideoData,
): Promise<VideoData | null> => {
  const contentToCheck = [
    videoData.title.toLowerCase(),
    videoData.description.toLowerCase(),
    videoData.tag.toLowerCase(),
  ].join(" ");

  if (
    Array.isArray(config.processing.filtering.typeIdWhitelist) &&
    config.processing.filtering.typeIdWhitelist.length > 0
  ) {
    if (
      !config.processing.filtering.typeIdWhitelist.includes(videoData.type_id)
    ) {
      let inwhite = false;
      if (
        Array.isArray(config.processing.filtering.contentWhitelist) &&
        config.processing.filtering.contentWhitelist.length > 0
      ) {
        for (const keyword of config.processing.filtering.contentWhitelist) {
          if (contentToCheck.includes(keyword.toLowerCase())) {
            logger.info(
              `${videoData.bvid} 包含白名单关键字 "${keyword}"，忽略类型检查: ${videoData.title}`,
            );
            inwhite = true;
            break;
          }
        }
      }
      if (!inwhite) {
        logger.info(
          `忽略类型 ${videoData.type_id}(${videoData.bvid}): ${videoData.title}`,
        );
        return null;
      }
    }
  }

  // Check copyright whitelist
  if (
    Array.isArray(config.processing.filtering.copyrightWhitelist) &&
    config.processing.filtering.copyrightWhitelist.length > 0 &&
    videoData.copyright !== undefined
  ) {
    if (
      !config.processing.filtering.copyrightWhitelist.includes(
        videoData.copyright,
      )
    ) {
      let inwhite = false;
      if (
        Array.isArray(config.processing.filtering.contentWhitelist) &&
        config.processing.filtering.contentWhitelist.length > 0
      ) {
        for (const keyword of config.processing.filtering.contentWhitelist) {
          if (contentToCheck.includes(keyword.toLowerCase())) {
            logger.info(
              `${videoData.bvid} 包含白名单关键字 "${keyword}"，忽略版权检查: ${videoData.title}`,
            );
            inwhite = true;
            break;
          }
        }
      }
      if (!inwhite) {
        logger.info(
          `忽略版权 ${videoData.copyright}(${videoData.bvid}): ${videoData.title}`,
        );
        return null;
      }
    }
  }

  // Check content blacklist
  if (
    Array.isArray(config.processing.filtering.contentBlacklist) &&
    config.processing.filtering.contentBlacklist.length > 0
  ) {
    for (const keyword of config.processing.filtering.contentBlacklist) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.info(
          `${videoData.bvid} 忽略包含黑名单关键字 "${keyword}": ${videoData.title}`,
        );
        return null;
      }
    }
  }

  return videoData;
};
