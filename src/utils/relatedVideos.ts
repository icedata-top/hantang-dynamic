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
 * Helper function to format video info for logging
 */
function formatVideoInfo(videoId: { aid?: number; bvid?: string }, title?: string): string {
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
 * Fetches and processes related videos for a given video
 * @param videoId The video ID (BVID or AID)
 * @param depth Current discovery depth
 * @param sourceTitle Optional source video title for better logging
 * @param sourcePubdate Optional source video publication timestamp for new video bypass
 * @returns Object containing related videos and whether source should be filtered
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
  if (sourcePubdate && config.processing.relatedVideos.newVideoBypassHours > 0) {
    const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
    const videoAge = currentTime - sourcePubdate; // Age in seconds
    const bypassThreshold = config.processing.relatedVideos.newVideoBypassHours * 3600; // Convert hours to seconds
    
    if (videoAge < bypassThreshold) {
      const videoInfo = formatVideoInfo(videoId, sourceTitle);
      const ageHours = (videoAge / 3600).toFixed(1);
      logger.info(
        `Video ${videoInfo} is ${ageHours}h old (< ${config.processing.relatedVideos.newVideoBypassHours}h threshold). Will process related videos but skip source filtering.`
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
    const videoInfo = formatVideoInfo(videoId, sourceTitle);
    logger.debug(
      `Fetching related videos for ${videoInfo} (depth: ${depth})`,
    );

    // Fetch related videos from API
    const relatedVideos = await fetchRelatedVideos(videoId);

    if (!relatedVideos.length) {
      logger.debug(
        `No related videos found for ${videoInfo}`,
      );
      return { relatedVideos: [], shouldFilterSource: false };
    }

    // Limit the number of related videos to process
    const limitedRelatedVideos = relatedVideos.slice(
      0,
      config.processing.relatedVideos.maxPerVideo,
    );

    logger.debug(
      `Processing ${limitedRelatedVideos.length} related videos (of ${relatedVideos.length} available)`,
    );

    // Convert to VideoData format and track filtering results
    const videoDataList: VideoData[] = [];
    let totalProcessed = 0;
    let filteredOut = 0;
    
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

      totalProcessed++;

      // Apply filtering if enabled
      if (config.processing.relatedVideos.respectMainFilters) {
        const filteredVideoData = await filterVideo(videoData);
        if (filteredVideoData) {
          videoDataList.push(filteredVideoData);
        } else {
          filteredOut++;
          logger.debug(
            `Related video ${relatedVideo.bvid} filtered out by main filters`,
          );
        }
      } else {
        videoDataList.push(videoData);
      }
    }

    // First stage: Determine if source video should be filtered based on related video filter rate
    const filterRate = totalProcessed > 0 ? filteredOut / totalProcessed : 0;
    const shouldFilterSource = !bypassSourceFiltering && filterRate >= config.processing.relatedVideos.filterSourceThreshold;
    const sourceVideoInfo = formatVideoInfo(videoId, sourceTitle);
    
    if (shouldFilterSource) {
      logger.info(
        `${filteredOut}/${totalProcessed} (${(filterRate * 100).toFixed(1)}%)  related videos were filtered. Dropping all related videos of Source video ${sourceVideoInfo} `,
      );
      // Return empty related videos since we're dropping the source
      return { 
        relatedVideos: [], 
        shouldFilterSource: true 
      };
    }

    // Second stage: Source video passed the filter rate test, process the passing related videos
    if (bypassSourceFiltering) {
      logger.info(
        `Source video ${sourceVideoInfo} bypassed filtering (new video): ${filteredOut}/${totalProcessed} (${(filterRate * 100).toFixed(1)}%) filtered. Processing ${videoDataList.length} passing related videos.`,
      );
    } else {
      logger.info(
        ` ${filteredOut}/${totalProcessed} (${(filterRate * 100).toFixed(1)}%) filtered. Processing ${videoDataList.length} passing related videos. Source video ${sourceVideoInfo} will be kept.`,
      );
    }

    // Additional quality check: Even if depth limit is reached, check related videos of the passing videos
    // to ensure they are truly high quality (secondary quality gate)
    const finalVideoList: VideoData[] = [];
    
    for (let i = 0; i < videoDataList.length; i++) {
      const video = videoDataList[i];
      
      try {
        // Add rate limiting between secondary checks
        if (i > 0) {
          await sleep(config.processing.relatedVideos.rateLimitDelay);
        }
        
        logger.debug(`Secondary quality check for related video: ${video.bvid}`);
        
        // Fetch related videos of this level 1 video for quality assessment
        const secondLevelRelated = await fetchRelatedVideos({ bvid: video.bvid });
        
        if (secondLevelRelated.length === 0) {
          // If no related videos found, assume it's acceptable
          finalVideoList.push(video);
          continue;
        }
        
        // Apply filtering to a sample of second-level related videos for quality assessment
        const sampleSize = Math.min(5, secondLevelRelated.length); // Check up to 5 for efficiency
        const sample = secondLevelRelated.slice(0, sampleSize);
        
        let sampleFilteredOut = 0;
        for (const sampleVideo of sample) {
          const sampleVideoData = convertRelatedVideoToVideoData(
            sampleVideo,
            video.bvid,
            depth + 2,
          );
          
          if (config.processing.relatedVideos.respectMainFilters) {
            const filtered = await filterVideo(sampleVideoData);
            if (!filtered) {
              sampleFilteredOut++;
            }
          }
        }
        
        // Check if this level 1 video should be kept based on its related videos quality
        const sampleFilterRate = sampleFilteredOut / sample.length;
        if (sampleFilterRate >= config.processing.relatedVideos.filterSourceThreshold) {
          logger.debug(
            `Dropping related video ${video.bvid}: ${sampleFilteredOut}/${sample.length} (${(sampleFilterRate * 100).toFixed(1)}%) of its related videos were filtered`,
          );
        } else {
          finalVideoList.push(video);
        }
        
      } catch (error) {
        logger.warn(`Failed secondary quality check for ${video.bvid}, keeping video: ${error}`);
        // If secondary check fails, keep the video (fail safe)
        finalVideoList.push(video);
      }
    }
    
    logger.info(
      `After secondary quality check: ${finalVideoList.length}/${videoDataList.length} related videos passed from related video ${sourceVideoInfo}`,
    );

    // Check if too many related videos failed the secondary quality check
    // If so, we should also drop the source video
    const secondaryFailedCount = videoDataList.length - finalVideoList.length;
    const secondaryFilterRate = videoDataList.length > 0 ? secondaryFailedCount / videoDataList.length : 0;
    
    if (secondaryFilterRate >= config.processing.relatedVideos.filterSourceThreshold) {
      logger.info(
        `Source video ${sourceVideoInfo} marked for filtering due to secondary quality check: ${secondaryFailedCount}/${videoDataList.length} (${(secondaryFilterRate * 100).toFixed(1)}%) related videos failed secondary check. Dropping source video.`,
      );
      return { 
        relatedVideos: [], 
        shouldFilterSource: true 
      };
    }

    return { 
      relatedVideos: finalVideoList, 
      shouldFilterSource: false 
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
 * @param videoDataList Array of video data to process for related videos
 * @param depth Current discovery depth
 * @returns Object containing all discovered related videos and source videos to filter
 */
export async function batchProcessRelatedVideos(
  videoDataList: VideoData[],
  depth: number = 0,
): Promise<BatchRelatedVideosResult> {
  if (!config.processing.features.enableRelatedVideos || !videoDataList.length) {
    return { relatedVideos: [], filteredSourceVideos: [] };
  }

  const allRelatedVideos: VideoData[] = [];
  const filteredSourceVideos: string[] = [];
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
          videoData.title, // Pass the title for better logging
          videoData.pubdate, // Pass the publication date for new video bypass
        ),
      ),
    );

    // Collect successful results
    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === "fulfilled") {
        allRelatedVideos.push(...result.value.relatedVideos);
        
        // Track source videos that should be filtered
        if (result.value.shouldFilterSource) {
          const sourceVideo = batch[j];
          filteredSourceVideos.push(sourceVideo.bvid);
        }
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
    `Batch processing completed: discovered ${allRelatedVideos.length} related videos from ${videoDataList.length} source videos. ${filteredSourceVideos.length} source videos marked for filtering.`,
  );

  return { relatedVideos: allRelatedVideos, filteredSourceVideos };
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
