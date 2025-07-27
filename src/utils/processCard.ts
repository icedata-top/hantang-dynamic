import { fetchVideoTags } from "../api/video";
import { config } from "../config";
import type { BiliDynamicCard, BiliVideoCard, VideoData } from "../types";
import { sleep } from "./datetime";
import { logger } from "./logger";

export const processCard = async (
  dynamiccard: BiliDynamicCard,
): Promise<VideoData> => {
  const card: BiliVideoCard = JSON.parse(dynamiccard.card);
  let tagString = "";

  if (config.processing.features.enableTagFetch) {
    try {
      const { data: VideoTagResponse } = await fetchVideoTags(
        dynamiccard.desc.bvid,
      );
      tagString = VideoTagResponse.map((t) => t.tag_name).join(";");
      logger.debug(`标签获取成功 ${dynamiccard.desc.bvid}:`, tagString);
      await sleep(config.application.apiWaitTime);
    } catch (error) {
      logger.error(
        `标签获取失败 ${dynamiccard.desc.bvid}:`,
        error instanceof Error ? error.message : "未知错误",
      );
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
