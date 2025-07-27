import { fetchRelatedVideos } from "../api/video";
import { config } from "../config";
import type { BiliRelatedVideo, VideoData } from "../types";
import { filterVideo } from "./filter";
import { logger } from "./logger";

/**
 * Converts BiliRelatedVideo to VideoData format for consistency with existing pipeline
 */
export function convertRelatedVideoToVideoData(
  relatedVideo: BiliRelatedVideo,
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
 * Helper function to format video info for logging
 */
function formatVideoInfo(
  videoId: { aid?: number; bvid?: string },
  title?: string,
): string {
  const id = videoId.bvid || videoId.aid;
  return title ? `${title} (${id})` : String(id);
}

/**
 * Result of processing related videos
 */
export interface RelatedVideosResult {
  relatedVideos: VideoData[];
  shouldFilterSource: boolean;
}

/**
 * Result of fetching and filtering primary related videos
 */
interface PrimaryVideosResult {
  acceptedVideos: VideoData[];
  filteredCount: number;
  totalCount: number;
}

/**
 * Fetches and filters the primary (first-level) related videos for a given video
 */
async function fetchAndFilterPrimaryVideos(
  videoId: { aid?: number; bvid?: string },
  sourceTitle?: string,
): Promise<PrimaryVideosResult> {
  const videoInfo = formatVideoInfo(videoId, sourceTitle);
  logger.debug(`Fetching related videos for ${videoInfo}`);

  // Fetch related videos from API
  const relatedVideos = await fetchRelatedVideos(videoId);

  if (!relatedVideos.length) {
    logger.debug(`No related videos found for ${videoInfo}`);
    return { acceptedVideos: [], filteredCount: 0, totalCount: 0 };
  }

  // Limit the number of related videos to process
  const limitedRelatedVideos = relatedVideos.slice(
    0,
    config.processing.relatedVideos.maxPerVideo,
  );

  logger.debug(
    `Processing ${limitedRelatedVideos.length} related videos (of ${relatedVideos.length} available)`,
  );

  // Convert to VideoData format and apply filtering
  const acceptedVideos: VideoData[] = [];
  let filteredCount = 0;

  for (const relatedVideo of limitedRelatedVideos) {
    const videoData = convertRelatedVideoToVideoData(relatedVideo);

    // Apply filtering if enabled
    if (config.processing.relatedVideos.respectMainFilters) {
      const filteredVideoData = await filterVideo(videoData);
      if (filteredVideoData) {
        acceptedVideos.push(filteredVideoData);
      } else {
        filteredCount++;
        logger.debug(
          `Related video ${relatedVideo.bvid} filtered out by main filters`,
        );
      }
    } else {
      acceptedVideos.push(videoData);
    }
  }

  return {
    acceptedVideos,
    filteredCount,
    totalCount: limitedRelatedVideos.length,
  };
}

/**
 * Evaluates whether a source video should be filtered based on the quality of its related videos
 */
function evaluateSourceVideoQuality(
  filteredCount: number,
  totalCount: number,
  sourceTitle?: string,
  bypassFiltering = false,
): boolean {
  if (totalCount === 0) {
    return false; // No related videos to judge quality
  }

  const filterRate = filteredCount / totalCount;
  const shouldFilter =
    !bypassFiltering &&
    filterRate >= config.processing.relatedVideos.filterSourceThreshold;

  if (shouldFilter) {
    logger.info(
      `${filteredCount}/${totalCount} (${(filterRate * 100).toFixed(1)}%) related videos were filtered. Source video ${sourceTitle || "unknown"} will be dropped.`,
    );
  } else if (bypassFiltering) {
    logger.info(
      `Source video ${sourceTitle || "unknown"} bypassed filtering (new video): ${filteredCount}/${totalCount} (${(filterRate * 100).toFixed(1)}%) filtered.`,
    );
  } else {
    logger.info(
      `${filteredCount}/${totalCount} (${(filterRate * 100).toFixed(1)}%) filtered. Source video ${sourceTitle || "unknown"} will be kept.`,
    );
  }

  return shouldFilter;
}

/**
 * Performs secondary quality check on a list of videos by sampling their related videos
 */
async function performSecondaryQualityCheck(
  videos: VideoData[],
): Promise<VideoData[]> {
  if (!videos.length) {
    return [];
  }

  logger.debug(`Performing secondary quality check on ${videos.length} videos`);

  const finalVideoList: VideoData[] = [];

  // Process all videos concurrently with Promise.allSettled
  const results = await Promise.allSettled(
    videos.map(async (video) => {
      try {
        logger.debug(
          `Secondary quality check for related video: ${video.bvid}`,
        );

        // Fetch related videos of this video for quality assessment
        const secondLevelRelated = await fetchRelatedVideos({
          bvid: video.bvid,
        });

        if (secondLevelRelated.length === 0) {
          // If no related videos found, assume it's acceptable
          return { video, passed: true };
        }

        let sampleFilteredOut = 0;

        // Process all secondary related videos concurrently
        const sampleResults = await Promise.allSettled(
          secondLevelRelated.map(async (sampleVideo) => {
            const sampleVideoData = convertRelatedVideoToVideoData(sampleVideo);

            if (config.processing.relatedVideos.respectMainFilters) {
              const filtered = await filterVideo(sampleVideoData);
              return !filtered; // Return true if filtered out
            }
            return false; // Not filtered
          }),
        );

        // Count filtered samples
        sampleFilteredOut = sampleResults.filter(
          (result) => result.status === "fulfilled" && result.value,
        ).length;

        // Check if this video should be kept based on its related videos quality
        const sampleFilterRate = sampleFilteredOut / secondLevelRelated.length;
        const passed =
          sampleFilterRate <
          config.processing.relatedVideos.filterSourceThreshold;

        if (!passed) {
          logger.debug(
            `Dropping related video ${video.bvid}: ${sampleFilteredOut}/${secondLevelRelated.length} (${(sampleFilterRate * 100).toFixed(1)}%) of its related videos were filtered`,
          );
        }

        return { video, passed };
      } catch (error) {
        logger.warn(
          `Failed secondary quality check for ${video.bvid}, keeping video: ${error}`,
        );
        // If secondary check fails, keep the video (fail safe)
        return { video, passed: true };
      }
    }),
  );

  // Collect videos that passed the secondary check
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.passed) {
      finalVideoList.push(result.value.video);
    }
  }

  logger.info(
    `After secondary quality check: ${finalVideoList.length}/${videos.length} related videos passed`,
  );

  return finalVideoList;
}

/**
 * Fetches and processes related videos for a given video
 */
export async function processRelatedVideos(
  videoId: { aid?: number; bvid?: string },
  depth: number = 0,
  sourceTitle?: string,
  sourcePubdate?: number,
): Promise<RelatedVideosResult> {
  if (!config.processing.features.enableRelatedVideos) {
    return { relatedVideos: [], shouldFilterSource: false };
  }

  // Check if video is too new to have reliable related videos for source filtering
  let bypassSourceFiltering = false;
  if (
    sourcePubdate &&
    config.processing.relatedVideos.newVideoBypassHours > 0
  ) {
    const currentTime = Math.floor(Date.now() / 1000);
    const videoAge = currentTime - sourcePubdate;
    const bypassThreshold =
      config.processing.relatedVideos.newVideoBypassHours * 3600;

    if (videoAge < bypassThreshold) {
      const videoInfo = formatVideoInfo(videoId, sourceTitle);
      const ageHours = (videoAge / 3600).toFixed(1);
      logger.info(
        `Video ${videoInfo} is ${ageHours}h old (< ${config.processing.relatedVideos.newVideoBypassHours}h threshold). Will process related videos but skip source filtering.`,
      );
      bypassSourceFiltering = true;
    }
  }

  // Respect max depth limit
  if (depth >= config.processing.relatedVideos.maxDepth) {
    const videoInfo = formatVideoInfo(videoId, sourceTitle);
    logger.debug(
      `Skipping related videos for ${videoInfo}: max depth ${config.processing.relatedVideos.maxDepth} reached`,
    );
    return { relatedVideos: [], shouldFilterSource: false };
  }

  try {
    // Step 1: Fetch and filter primary related videos
    const primaryResult = await fetchAndFilterPrimaryVideos(
      videoId,
      sourceTitle,
    );

    if (primaryResult.totalCount === 0) {
      return { relatedVideos: [], shouldFilterSource: false };
    }

    // Step 2: Evaluate source video quality based on primary related videos
    const shouldFilterSource = evaluateSourceVideoQuality(
      primaryResult.filteredCount,
      primaryResult.totalCount,
      sourceTitle,
      bypassSourceFiltering,
    );

    if (shouldFilterSource) {
      // Source video should be filtered, return empty related videos
      return { relatedVideos: [], shouldFilterSource: true };
    }

    // Step 3: Perform secondary quality check on accepted videos
    const finalVideoList = await performSecondaryQualityCheck(
      primaryResult.acceptedVideos,
    );

    // Step 4: Check if too many videos failed the secondary quality check
    if (primaryResult.acceptedVideos.length > 0) {
      const secondaryFailedCount =
        primaryResult.acceptedVideos.length - finalVideoList.length;
      const secondaryFilterRate =
        secondaryFailedCount / primaryResult.acceptedVideos.length;

      if (
        secondaryFilterRate >=
        config.processing.relatedVideos.filterSourceThreshold
      ) {
        const videoInfo = formatVideoInfo(videoId, sourceTitle);
        logger.info(
          `Source video ${videoInfo} marked for filtering due to secondary quality check: ${secondaryFailedCount}/${primaryResult.acceptedVideos.length} (${(secondaryFilterRate * 100).toFixed(1)}%) related videos failed secondary check.`,
        );
        return { relatedVideos: [], shouldFilterSource: true };
      }
    }

    return {
      relatedVideos: finalVideoList,
      shouldFilterSource: false,
    };
  } catch (error) {
    const sourceVideoInfo = formatVideoInfo(videoId, sourceTitle);
    logger.error(
      `Failed to process related videos for ${sourceVideoInfo}:`,
      error,
    );
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return { relatedVideos: [], shouldFilterSource: false };
  }
}

/**
 * Result of batch processing related videos
 */
export interface BatchRelatedVideosResult {
  relatedVideos: VideoData[];
  filteredSourceVideos: string[]; // BVIDs of source videos that should be filtered
}

/**
 * Batch processes multiple videos for related video discovery
 */
export async function batchProcessRelatedVideos(
  videoDataList: VideoData[],
  depth: number = 0,
): Promise<BatchRelatedVideosResult> {
  if (
    !config.processing.features.enableRelatedVideos ||
    !videoDataList.length
  ) {
    return { relatedVideos: [], filteredSourceVideos: [] };
  }

  const allRelatedVideos: VideoData[] = [];
  const filteredSourceVideos: string[] = [];

  logger.info(
    `Starting batch processing of ${videoDataList.length} videos for related videos (depth: ${depth})`,
  );

  // Process all videos concurrently using Promise.allSettled (no manual batching needed with proxy)
  const batchResults = await Promise.allSettled(
    videoDataList.map((videoData) =>
      processRelatedVideos(
        { bvid: videoData.bvid },
        depth,
        videoData.title, // Pass the title for better logging
        videoData.pubdate, // Pass the publication date for new video bypass
      ),
    ),
  );

  // Collect successful results
  for (let i = 0; i < batchResults.length; i++) {
    const result = batchResults[i];
    if (result.status === "fulfilled") {
      allRelatedVideos.push(...result.value.relatedVideos);

      // Track source videos that should be filtered
      if (result.value.shouldFilterSource) {
        const sourceVideo = videoDataList[i];
        filteredSourceVideos.push(sourceVideo.bvid);
      }
    } else {
      logger.error("Failed to process related videos in batch:", result.reason);
    }
  }

  logger.info(
    `Batch processing completed: discovered ${allRelatedVideos.length} related videos from ${videoDataList.length} source videos. ${filteredSourceVideos.length} source videos marked for filtering.`,
  );

  return { relatedVideos: allRelatedVideos, filteredSourceVideos };
}

/**
 * Prevents circular dependencies and infinite loops in related video discovery
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
