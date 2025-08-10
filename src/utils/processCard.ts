import type { BiliDynamicCard, VideoData } from "../types";
import { processVideo } from "./processVideo";

export const processCard = async (
  dynamiccard: BiliDynamicCard
): Promise<VideoData> => {
  const bvid = dynamiccard.desc.bvid;
  return await processVideo(bvid, (dynamiccard = dynamiccard));
};
