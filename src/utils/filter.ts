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

  // A positive tid_v2 is judged by the tid_v2 list when one is configured;
  // otherwise the type_id list decides.
  const tidV2List = config.whitelist.video.tidV2;
  const useTidV2 =
    Array.isArray(tidV2List) &&
    tidV2List.length > 0 &&
    videoData.tid_v2 !== undefined &&
    videoData.tid_v2 > 0;
  const typeList = useTidV2 ? tidV2List : config.whitelist.video.typeIds;
  const typeValue = useTidV2 ? videoData.tid_v2 : videoData.type_id;
  const typeLabel = useTidV2 ? "tid_v2" : "类型";

  if (Array.isArray(typeList) && typeList.length > 0) {
    if (typeValue === undefined || !typeList.includes(typeValue)) {
      let inwhite = false;
      if (
        Array.isArray(config.whitelist.video.contentKeywords) &&
        config.whitelist.video.contentKeywords.length > 0
      ) {
        for (const keyword of config.whitelist.video.contentKeywords) {
          if (contentToCheck.includes(keyword.toLowerCase())) {
            logger.debug(
              `${videoData.bvid} 包含白名单关键字 "${keyword}"，忽略类型检查: ${videoData.title}`,
            );
            inwhite = true;
            break;
          }
        }
      }
      if (!inwhite) {
        logger.debug(
          `忽略${typeLabel} ${typeValue}(${videoData.bvid}): ${videoData.title}`,
        );
        return null;
      }
    }
  }

  // Check copyright whitelist
  if (
    Array.isArray(config.whitelist.video.copyrightTypes) &&
    config.whitelist.video.copyrightTypes.length > 0 &&
    videoData.copyright !== undefined
  ) {
    if (!config.whitelist.video.copyrightTypes.includes(videoData.copyright)) {
      let inwhite = false;
      if (
        Array.isArray(config.whitelist.video.contentKeywords) &&
        config.whitelist.video.contentKeywords.length > 0
      ) {
        for (const keyword of config.whitelist.video.contentKeywords) {
          if (contentToCheck.includes(keyword.toLowerCase())) {
            logger.debug(
              `${videoData.bvid} 包含白名单关键字 "${keyword}"，忽略版权检查: ${videoData.title}`,
            );
            inwhite = true;
            break;
          }
        }
      }
      if (!inwhite) {
        logger.debug(
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
        logger.debug(
          `${videoData.bvid} 忽略包含黑名单关键字 "${keyword}": ${videoData.title}`,
        );
        return null;
      }
    }
  }

  return videoData;
};
