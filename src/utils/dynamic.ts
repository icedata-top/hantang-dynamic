import { getDynamic } from "../api/dynamic";
import { config } from "../config";
import type { BiliDynamicCard, VideoData } from "../types";
import { sleep } from "./datetime";
import { filterNewDynamics, filterNewVideoData } from "./deduplicator";
import { filterVideo } from "./filter";
import { logger } from "./logger";
import { processCard } from "./processCard";

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

  // Early deduplication: Check database BEFORE processing to save CPU/API calls
  if (
    config.processing.features.enableDeduplication &&
    videoDynamics.length > 0
  ) {
    videoDynamics = await filterNewDynamics(videoDynamics);
    logger.info(
      `After database deduplication: ${videoDynamics.length} new dynamics to process`,
    );
  }

  for (const dynamic of videoDynamics) {
    videoData.push(await processCard(dynamic));
  }

  videoData = (await Promise.all(videoData.map(filterVideo))).filter(
    (video): video is VideoData => video !== null,
  );

  // Final safety check for any edge cases (usually unnecessary now)
  if (config.processing.features.enableDeduplication && videoData.length > 0) {
    videoData = await filterNewVideoData(videoData);
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
  await sleep(config.application.apiWaitTime);

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
