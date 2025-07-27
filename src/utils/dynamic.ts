import { getDynamic } from "../api/dynamic";
import { config } from "../config";
import type { BiliDynamicCard, VideoData } from "../types";
import { sleep } from "./datetime";
import { filterNewDynamics, filterNewVideoData } from "./deduplicator";
import { filterVideo } from "./filter";
import { logger } from "./logger";
import { processCard } from "./processCard";
import { batchProcessRelatedVideos } from "./relatedVideos";
import {
  isVideoRejected,
  logRejectedVideo,
  RejectionReason,
} from "./rejectedVideoLogger";

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

  // Apply filtering and log rejected videos
  const originalVideoData = [...videoData];
  videoData = (await Promise.all(videoData.map(filterVideo))).filter(
    (video): video is VideoData => video !== null,
  );

  // Log rejected videos for analytics
  const rejectedVideos = originalVideoData.filter(
    (original) =>
      !videoData.find((accepted) => accepted.bvid === original.bvid),
  );

  if (rejectedVideos.length > 0) {
    logger.info(
      `${rejectedVideos.length} videos were filtered out by main filters`,
    );

    // Log rejected videos asynchronously to avoid blocking main flow
    Promise.all(
      rejectedVideos.map((video) =>
        logRejectedVideo(video, RejectionReason.CONTENT_BLACKLIST),
      ),
    ).catch((error) => {
      logger.warn("Failed to log some rejected videos:", error);
    });
  }

  // Final safety check for any edge cases (usually unnecessary now)
  if (config.processing.features.enableDeduplication && videoData.length > 0) {
    videoData = await filterNewVideoData(videoData);
  }

  // Process related videos if enabled and API proxy is configured
  if (config.processing.features.enableRelatedVideos && videoData.length > 0) {
    // Check if API proxy is configured
    if (!config.bilibili.apiProxyUrl) {
      logger.warn(
        "Related videos feature is enabled but no API proxy URL is configured. " +
          "Related videos feature requires API proxy to avoid rate limiting. " +
          "Please set 'api_proxy_url' in [bilibili] section of config.toml. " +
          "Skipping related videos processing.",
      );
    } else {
      logger.info(`Processing related videos for ${videoData.length} videos`);

      try {
        const relatedResult = await batchProcessRelatedVideos(videoData);

        // Filter out source videos that should be removed based on related video quality
        // This needs to happen regardless of whether related videos were found
        if (relatedResult.filteredSourceVideos.length > 0) {
          const originalCount = videoData.length;
          videoData = videoData.filter(
            (video) => !relatedResult.filteredSourceVideos.includes(video.bvid),
          );
          logger.info(
            `Filtered out ${originalCount - videoData.length} source videos based on related video quality`,
          );
        }

        if (relatedResult.relatedVideos.length > 0) {
          logger.info(
            `Found ${relatedResult.relatedVideos.length} related videos`,
          );

          // Filter out previously rejected videos before further processing
          const originalRelatedCount = relatedResult.relatedVideos.length;
          const notRejectedRelatedVideos = [];

          for (const video of relatedResult.relatedVideos) {
            const isRejected = await isVideoRejected(video.bvid);
            if (!isRejected) {
              notRejectedRelatedVideos.push(video);
            }
          }

          if (notRejectedRelatedVideos.length !== originalRelatedCount) {
            logger.info(
              `Filtered out ${originalRelatedCount - notRejectedRelatedVideos.length} previously rejected related videos`,
            );
          }

          // Apply deduplication to related videos if enabled
          let filteredRelatedVideos = notRejectedRelatedVideos;
          if (config.processing.features.enableDeduplication) {
            filteredRelatedVideos = await filterNewVideoData(
              notRejectedRelatedVideos,
            );
            logger.info(
              `After deduplication: ${filteredRelatedVideos.length} new related videos`,
            );
          }

          // Add related videos to final result
          videoData.push(...filteredRelatedVideos);

          logger.info(
            `Total videos after related video processing: ${videoData.length}`,
          );
        } else {
          logger.info("No related videos found");
        }
      } catch (error) {
        logger.error("Failed to process related videos:", error);
        // Continue without related videos on error
      }
    }
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
