import { fetchRelatedVideos } from "../api/video";
import { config } from "../config";
import type { BiliRelatedVideo, VideoData } from "../types";
import { sleep } from "./datetime";
import { filterVideo } from "./filter";
import { logger } from "./logger";

/**
 * Converts BiliRelatedVideo to VideoData format for consistency with existing pipeline
 * @param relatedVideo The related video from Bilibili API
 * @param sourceVideoId The ID of the video that led to this related video
 * @param depth The discovery depth (0 = original video, 1 = first level related, etc.)
 * @returns VideoData object
 */
export function convertRelatedVideoToVideoData(
  relatedVideo: BiliRelatedVideo,
  sourceVideoId: string,
  depth: number,
): VideoData {
  return {
    aid: BigInt(relatedVideo.aid),
    bvid: relatedVideo.bvid,
    pubdate: relatedVideo.pubdate,
    title: relatedVideo.title,
    description: relatedVideo.desc,
    // For related videos, we don't fetch tags by default to reduce API calls
    tag: "",
    pic: relatedVideo.pic,
    type_id: relatedVideo.tid,
    user_id: BigInt(relatedVideo.owner.mid),
  };
}

/**
 * Fetches and processes related videos for a given video
 * @param videoId The video ID (BVID or AID)
 * @param depth Current discovery depth
 * @returns Array of processed VideoData from related videos
 */
export async function processRelatedVideos(
  videoId: { aid?: number; bvid?: string },
  depth: number = 0,
): Promise<VideoData[]> {
  if (!config.processing.features.enableRelatedVideos) {
    return [];
  }

  // Respect max depth limit
  if (depth >= config.processing.relatedVideos.maxDepth) {
    logger.debug(
      `Skipping related videos for ${videoId.bvid || videoId.aid}: max depth ${config.processing.relatedVideos.maxDepth} reached`,
    );
    return [];
  }

  try {
    logger.info(
      `Fetching related videos for ${videoId.bvid || videoId.aid} (depth: ${depth})`,
    );

    // Fetch related videos from API
    const relatedVideos = await fetchRelatedVideos(videoId);

    if (!relatedVideos.length) {
      logger.debug(
        `No related videos found for ${videoId.bvid || videoId.aid}`,
      );
      return [];
    }

    // Limit the number of related videos to process
    const limitedRelatedVideos = relatedVideos.slice(
      0,
      config.processing.relatedVideos.maxPerVideo,
    );

    logger.info(
      `Processing ${limitedRelatedVideos.length} related videos (of ${relatedVideos.length} available)`,
    );

    // Convert to VideoData format
    const videoDataList: VideoData[] = [];
    for (let i = 0; i < limitedRelatedVideos.length; i++) {
      const relatedVideo = limitedRelatedVideos[i];

      // Add rate limiting to respect API limits
      if (i > 0) {
        await sleep(config.processing.relatedVideos.rateLimitDelay);
      }

      const videoData = convertRelatedVideoToVideoData(
        relatedVideo,
        videoId.bvid || String(videoId.aid || ""),
        depth + 1,
      );

      // Apply filtering if enabled
      if (config.processing.relatedVideos.respectMainFilters) {
        const filteredVideoData = await filterVideo(videoData);
        if (filteredVideoData) {
          videoDataList.push(filteredVideoData);
        } else {
          logger.debug(
            `Related video ${relatedVideo.bvid} filtered out by main filters`,
          );
        }
      } else {
        videoDataList.push(videoData);
      }
    }

    logger.info(
      `Successfully processed ${videoDataList.length} related videos for ${videoId.bvid || videoId.aid}`,
    );

    return videoDataList;
  } catch (error) {
    logger.error(
      `Failed to process related videos for ${videoId.bvid || videoId.aid}:`,
      error,
    );
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return [];
  }
}

/**
 * Batch processes multiple videos for related video discovery
 * @param videoDataList Array of video data to process for related videos
 * @param depth Current discovery depth
 * @returns Array of all discovered related videos
 */
export async function batchProcessRelatedVideos(
  videoDataList: VideoData[],
  depth: number = 0,
): Promise<VideoData[]> {
  if (!config.processing.features.enableRelatedVideos || !videoDataList.length) {
    return [];
  }

  const allRelatedVideos: VideoData[] = [];
  const batchSize = config.processing.relatedVideos.batchSize;

  logger.info(
    `Starting batch processing of ${videoDataList.length} videos for related videos (depth: ${depth})`,
  );

  // Process in batches to manage API rate limits
  for (let i = 0; i < videoDataList.length; i += batchSize) {
    const batch = videoDataList.slice(i, i + batchSize);

    logger.debug(
      `Processing related videos batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(videoDataList.length / batchSize)} (${batch.length} videos)`,
    );

    // Process batch concurrently but with controlled concurrency
    const batchResults = await Promise.allSettled(
      batch.map((videoData) =>
        processRelatedVideos(
          { bvid: videoData.bvid },
          depth,
        ),
      ),
    );

    // Collect successful results
    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        allRelatedVideos.push(...result.value);
      } else {
        logger.error("Failed to process related videos in batch:", result.reason);
      }
    }

    // Add delay between batches
    if (i + batchSize < videoDataList.length) {
      await sleep(config.processing.relatedVideos.rateLimitDelay * 2);
    }
  }

  logger.info(
    `Batch processing completed: discovered ${allRelatedVideos.length} related videos from ${videoDataList.length} source videos`,
  );

  return allRelatedVideos;
}

/**
 * Prevents circular dependencies and infinite loops in related video discovery
 * @param videoId The video ID to check
 * @param processedVideos Set of already processed video IDs
 * @returns True if the video should be processed, false if it would create a loop
 */
export function shouldProcessRelatedVideo(
  videoId: string,
  processedVideos: Set<string>,
): boolean {
  if (processedVideos.has(videoId)) {
    logger.debug(
      `Skipping related video ${videoId}: already processed (circular dependency prevention)`,
    );
    return false;
  }
  return true;
}
