import { config } from "../core/config";
import type {
  BiliDynamicCard,
  VideoData,
  BiliCards,
  VideoTagResponse,
} from "../core/types";
import { fetchVideoTags } from "../api/video";
import { sleep } from "./datetime";

export const processCard = async (
  dynamiccard: BiliDynamicCard,
): Promise<VideoData | null> => {
  const card: BiliCards = JSON.parse(dynamiccard.card);
  let tagString = "";

  if (
    Array.isArray(config.TYPE_ID_WHITE_LIST) &&
    config.TYPE_ID_WHITE_LIST.length > 0
  ) {
    if (!config.TYPE_ID_WHITE_LIST.includes(card.tid)) {
      console.log(`忽略类型 ${card.tid}: ${card.title}`);
      return null;
    }
  }

  if (config.ENABLE_TAG_FETCH) {
    try {
      const { data: VideoTagResponse } = await fetchVideoTags(
        dynamiccard.desc.bvid,
      );
      tagString = VideoTagResponse.map((t) => t.tag_name).join(";");
      console.log(`标签获取成功 ${dynamiccard.desc.bvid}:`, tagString);
      await sleep(config.API_WAIT_TIME);
    } catch (error) {
      console.error(
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
