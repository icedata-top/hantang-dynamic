import { config } from "../core/config";
import { BiliCard } from "../core/types";
import { fetchVideoTags } from "../api/video";
import { sleep } from "./datetime";
import type { VideoData } from "../core/types";

export const processCard = async (
  card: BiliCard,
): Promise<VideoData | null> => {
  const data = JSON.parse(card.card);
  let tagString = "";

  if (
    Array.isArray(config.TYPE_ID_WHITE_LIST) &&
    config.TYPE_ID_WHITE_LIST.length > 0
  ) {
    if (!config.TYPE_ID_WHITE_LIST.includes(data.tid)) {
      console.log(`忽略类型 ${data.tid}: ${data.title}`);
      return null;
    }
  }

  if (config.ENABLE_TAG_FETCH) {
    try {
      const { data: tagData } = await fetchVideoTags(card.desc.bvid);
      tagString = tagData.map((t) => t.tag_name).join(";");
      console.log(`标签获取成功 ${card.desc.bvid}:`, tagString);
      await sleep(config.API_WAIT_TIME);
    } catch (error) {
      console.error(
        `标签获取失败 ${card.desc.bvid}:`,
        error instanceof Error ? error.message : "未知错误",
      );
    }
  }

  return {
    aid: data.aid,
    bvid: card.desc.bvid,
    pubdate: data.pubdate,
    title: data.title,
    description: data.desc,
    tag: tagString,
    pic: data.pic,
    type_id: data.tid,
    user_id: card.desc.BILIBILI_UID,
  };
};
