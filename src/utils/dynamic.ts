import { BiliDynamicCard, VideoData } from "../core/types";
import { getDynamic } from "../api/dynamic";
import { sleep } from "./datetime";
import { config } from "../core/config";
import { processCard } from "./helpers";
import { logger } from "./logger";

export async function filterAndProcessDynamics(
  dynamics: BiliDynamicCard[],
): Promise<VideoData[]> {
  let videoData: VideoData[] = [];
  logger.info(`Processing ${dynamics.length} dynamics`);

  // Filter and process forwarded dynamics
  let videoDynamics = await processForwardedDynamics(dynamics);

  // Remove duplicates based on bvid
  videoDynamics = removeDuplicateDynamics(videoDynamics);
  logger.info(`Processing ${videoDynamics.length} unique dynamics`);

  // Process each dynamic into video data
  for (const dynamic of videoDynamics) {
    const processedData = await processCard(dynamic);
    if (!processedData) continue;
    logger.debug(`Processed ${processedData.bvid}: ${processedData.title}`);
    videoData.push(processedData);
  }

  return videoData;
}

async function processForwardedDynamics(
  dynamics: BiliDynamicCard[],
): Promise<BiliDynamicCard[]> {
  const videoDynamics: BiliDynamicCard[] = [];

  for (let dynamic of dynamics) {
    if (dynamic.desc.type !== 8 && dynamic.desc.type !== 1) {
      logger.debug(`Skip dynamic ${dynamic.desc.dynamic_id}`);
      continue;
    }

    if (dynamic.desc.type === 1) {
      const forwardedDynamic = await handleForwardedDynamic(dynamic);
      if (!forwardedDynamic) continue;
      dynamic = forwardedDynamic;
    }

    videoDynamics.push(dynamic);
  }

  return videoDynamics;
}

async function handleForwardedDynamic(
  dynamic: BiliDynamicCard,
): Promise<BiliDynamicCard | null> {
  if (!dynamic.desc.origin) return null;
  if (dynamic.desc.origin.type !== 8) {
    logger.info(`Skip dynamic ${dynamic.desc.dynamic_id_str}`);
    return null;
  }

  logger.info(`Processing forward dynamic ${dynamic.desc.dynamic_id_str}`);
  const newDynamic = await getDynamic(dynamic.desc.origin.dynamic_id_str);
  await sleep(config.API_WAIT_TIME);

  return newDynamic ? newDynamic.data.card : null;
}

function removeDuplicateDynamics(
  dynamics: BiliDynamicCard[],
): BiliDynamicCard[] {
  return dynamics.filter(
    (dynamic, index, self) =>
      index === self.findIndex((t) => t.desc.bvid === dynamic.desc.bvid),
  );
}
