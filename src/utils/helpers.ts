import { config } from "../core/config";
import { logger } from "./logger";
import type {
  BiliDynamicCard,
  VideoData,
  BiliVideoCard,
  VideoTagResponse,
} from "../core/types";
import { fetchVideoTags } from "../api/video";
import { sleep } from "./datetime";

export const processDynamic = async (
  dynamiccard: BiliDynamicCard,
): Promise<VideoData | null> => {
  const card: BiliVideoCard = JSON.parse(dynamiccard.card);
  let tagString = "";

  if (
    Array.isArray(config.TYPE_ID_WHITE_LIST) &&
    config.TYPE_ID_WHITE_LIST.length > 0
  ) {
    if (!config.TYPE_ID_WHITE_LIST.includes(card.tid)) {
      logger.info(`忽略类型 ${card.tid}: ${card.title}`);
      return null;
    }
  }

  if (config.ENABLE_TAG_FETCH) {
    try {
      const { data: VideoTagResponse } = await fetchVideoTags(
        dynamiccard.desc.bvid,
      );
      tagString = VideoTagResponse.map((t) => t.tag_name).join(";");
      logger.info(`标签获取成功 ${dynamiccard.desc.bvid}:`, tagString);
      await sleep(config.API_WAIT_TIME);
    } catch (error) {
      logger.error(
        `标签获取失败 ${dynamiccard.desc.bvid}:`,
        error instanceof Error ? error.message : "未知错误",
      );
    }
  }

  const contentToCheck = [
    card.title.toLowerCase(),
    card.desc.toLowerCase(),
    tagString.toLowerCase()
  ].join(" ");
  
  // Check content whitelist first - if matches, prioritize and log it
  if (Array.isArray(config.CONTENT_WHITE_LIST) && config.CONTENT_WHITE_LIST.length > 0) {
    for (const keyword of config.CONTENT_WHITE_LIST) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.info(`优先包含白名单关键字 "${keyword}": ${card.title}`);
        return {
          aid: card.aid,
          bvid: dynamiccard.desc.bvid,
          pubdate: card.pubdate,
          title: card.title,
          description: card.desc,
          tag: tagString,
          pic: card.pic,
          type_id: card.tid,
          user_id: card.owner.mid,
        };
      }
    }
  }

  // Check content blacklist if not whitelisted
  if (Array.isArray(config.CONTENT_BLACK_LIST) && config.CONTENT_BLACK_LIST.length > 0) {
    for (const keyword of config.CONTENT_BLACK_LIST) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.info(`忽略包含黑名单关键字 "${keyword}": ${card.title}`);
        return null;
      }
    }
  }

  return {
    aid: card.aid,
    bvid: dynamiccard.desc.bvid,
    pubdate: card.pubdate,
    title: card.title,
    description: card.desc,
    tag: tagString,
    pic: card.pic,
    type_id: card.tid,
    user_id: card.owner.mid,
  };
};

export const processCard = async (
  dynamiccard: BiliDynamicCard,
): Promise<VideoData | null> => {
  const card: BiliVideoCard = JSON.parse(dynamiccard.card);
  let tagString = "";

  if (
    Array.isArray(config.TYPE_ID_WHITE_LIST) &&
    config.TYPE_ID_WHITE_LIST.length > 0
  ) {
    if (!config.TYPE_ID_WHITE_LIST.includes(card.tid)) {
      logger.debug(`忽略类型 ${card.tid}: ${card.title}`);
      return null;
    }
  }

  if (config.ENABLE_TAG_FETCH) {
    try {
      const { data: VideoTagResponse } = await fetchVideoTags(
        dynamiccard.desc.bvid,
      );
      tagString = VideoTagResponse.map((t) => t.tag_name).join(";");
      logger.debug(`标签获取成功 ${dynamiccard.desc.bvid}:`, tagString);
      await sleep(config.API_WAIT_TIME);
    } catch (error) {
      logger.error(
        `标签获取失败 ${dynamiccard.desc.bvid}:`,
        error instanceof Error ? error.message : "未知错误",
      );
    }
  }

  const contentToCheck = [
    card.title.toLowerCase(),
    card.desc.toLowerCase(),
    tagString.toLowerCase()
  ].join(" ");
  
  // Check content whitelist first - if matches, prioritize and log it
  if (Array.isArray(config.CONTENT_WHITE_LIST) && config.CONTENT_WHITE_LIST.length > 0) {
    for (const keyword of config.CONTENT_WHITE_LIST) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.info(`优先包含白名单关键字 "${keyword}": ${card.title}`);
        return {
          aid: card.aid,
          bvid: dynamiccard.desc.bvid,
          pubdate: card.pubdate,
          title: card.title,
          description: card.desc,
          tag: tagString,
          pic: card.pic,
          type_id: card.tid,
          user_id: card.owner.mid,
        };
      }
    }
  }

  // Check content blacklist if not whitelisted
  if (Array.isArray(config.CONTENT_BLACK_LIST) && config.CONTENT_BLACK_LIST.length > 0) {
    for (const keyword of config.CONTENT_BLACK_LIST) {
      if (contentToCheck.includes(keyword.toLowerCase())) {
        logger.debug(`忽略包含黑名单关键字 "${keyword}": ${card.title}`);
        return null;
      }
    }
  }

  return {
    aid: card.aid,
    bvid: dynamiccard.desc.bvid,
    pubdate: card.pubdate,
    title: card.title,
    description: card.desc,
    tag: tagString,
    pic: card.pic,
    type_id: card.tid,
    user_id: card.owner.mid,
  };
};
