import { fetchVideoFullDetail } from "../api/video";
import { config } from "../config";
import type {
  BiliDynamicCard,
  BiliVideoCard,
  VideoData,
  BiliRelatedVideo,
} from "../types";
import { sleep } from "./datetime";
import { logger } from "./logger";

export const processVideo = async (
  bvid: string,
  dynamiccard?: BiliDynamicCard,
  relatedvideo?: BiliRelatedVideo,
): Promise<VideoData> => {
  const tagString = "";
  let copyrightStatus = 1;

  try {
    const videoFullDetail = await fetchVideoFullDetail({
      bvid: bvid,
    });

    copyrightStatus = videoFullDetail.data.View.copyright;

    const view = videoFullDetail.data.View;
    await sleep(config.application.apiWaitTime);
    return {
      aid: BigInt(view.aid),
      bvid: view.bvid,
      pubdate: view.pubdate,
      title: view.title,
      description: view.desc,
      tag: videoFullDetail.data.Tags.map((t) => t.tag_name).join(";"),
      pic: view.pic,
      type_id: view.tid,
      user_id: BigInt(view.owner.mid),
      copyright: copyrightStatus,
    };
  } catch (error) {
    logger.warn(
      `视频详情获取失败 ${bvid}:`,
      error instanceof Error ? error.message : "未知错误",
    );

    if (dynamiccard) {
      const card: BiliVideoCard = JSON.parse(dynamiccard.card);
      return {
        aid: card.aid,
        bvid: dynamiccard.desc.bvid,
        pubdate: card.pubdate,
        title: card.title,
        description: card.desc,
        tag: tagString,
        pic: card.pic,
        type_id: card.tid,
        user_id: BigInt(card.owner.mid),
      };
    } else if (relatedvideo) {
      return {
        aid: BigInt(relatedvideo.aid),
        bvid: relatedvideo.bvid,
        pubdate: relatedvideo.pubdate,
        title: relatedvideo.title,
        description: relatedvideo.desc,
        tag: tagString,
        pic: relatedvideo.pic,
        type_id: relatedvideo.tid,
        user_id: BigInt(relatedvideo.owner.mid),
        copyright: copyrightStatus,
      };
    } else {
      logger.warn(`无法获取视频数据 ${bvid}, 返回空数据`);
      return {
        aid: BigInt(0),
        bvid: bvid,
        pubdate: 0,
        title: "",
        description: "",
        tag: tagString,
        pic: "",
        type_id: 0,
        user_id: BigInt(0),
      } as VideoData;
    }
  }
};
