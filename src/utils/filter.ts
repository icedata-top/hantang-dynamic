import { config } from "../core/config";
import { logger } from "./logger";
import type { VideoData } from "../core/types";

export const filterVideo = async (
  videoData: VideoData,
): Promise<VideoData | null> => {
  let contentToCheck = [
    videoData.title.toLowerCase(),
    videoData.description.toLowerCase(),
    videoData.tag.toLowerCase(),
  ].join(" ");

  if (
    Array.isArray(config.TYPE_ID_WHITE_LIST) &&
    config.TYPE_ID_WHITE_LIST.length > 0
  ) {
    if (!config.TYPE_ID_WHITE_LIST.includes(videoData.type_id)) {
      let inwhite = false;
      if (
        Array.isArray(config.CONTENT_WHITE_LIST) &&
        config.CONTENT_WHITE_LIST.length > 0
      ) {
        for (const keyword of config.CONTENT_WHITE_LIST) {
          if (contentToCheck.includes(keyword.toLowerCase())) {
            logger.info(
              `包含白名单关键字 "${keyword}"，忽略类型检查: ${videoData.title}`,
            );
            inwhite = true;
            break;
          }
        }
      }
      if (!inwhite) {
        logger.debug(`忽略类型 ${videoData.type_id}: ${videoData.title}`);
        return null;
      }
    }
  }

  // Check content blacklist
  if (
    Array.isArray(config.CONTENT_BLACK_LIST) &&
    config.CONTENT_BLACK_LIST.length > 0
  ) {
    for (const keyword of config.CONTENT_BLACK_LIST) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.debug(`忽略包含黑名单关键字 "${keyword}": ${videoData.title}`);
        return null;
      }
    }
  }

  return videoData;
};
