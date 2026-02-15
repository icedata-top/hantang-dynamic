import { getDynamic } from "../api/dynamic";
import { fetchVideoFullDetail } from "../api/video";
import { config } from "../config";
import { Database } from "../database";
import type { BiliDynamicCard, RecommendedVideo, VideoData } from "../types";
import { filterVideo } from "../utils/filter";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimiter";

export class DetailsService {
  private rateLimiter: RateLimiter;
  private db: Database;

  constructor() {
    this.db = Database.getInstance();
    this.rateLimiter = new RateLimiter(
      config.application.concurrencyLimit || 1,
    );
  }

  /**
   * Process a single dynamic card to extract video data.
   * Handles caching, forwarding resolution, and filtering.
   */
  async processVideo(
    dynamic: BiliDynamicCard,
    processRelated = true,
    source: "following" | "recommendation" = "following",
  ): Promise<{
    video: VideoData | null;
    relatedVideos: BiliDynamicCard[];
  }> {
    let bvid = dynamic.desc.bvid;
    try {
      // 1. Resolve BVID (handle forwards)
      if (dynamic.desc.type === 1) {
        // Forward type
        bvid = await this.resolveForward(dynamic);
        if (!bvid) {
          return { video: null, relatedVideos: [] };
        }
      }

      return await this.processVideoById(bvid, { processRelated, source });
    } catch (error) {
      logger.error(
        `Error processing dynamic ${dynamic.desc.dynamic_id}:`,
        error,
      );
      return { video: null, relatedVideos: [] };
    }
  }

  /**
   * Process a video by its ID (BVID or AID).
   * @param id Video ID (BVID string or AID number)
   * @param options Processing options
   * @param options.processRelated Whether to process related videos (default: true)
   * @param options.skipCacheCheck Whether to skip cache check for repair scenarios (default: false)
   */
  async processVideoById(
    id: string | number,
    options: {
      processRelated?: boolean;
      skipCacheCheck?: boolean;
      source?: "following" | "recommendation";
    } = {},
  ): Promise<{
    video: VideoData | null;
    relatedVideos: BiliDynamicCard[];
  }> {
    const {
      processRelated = true,
      skipCacheCheck = false,
      source = "following",
    } = options;

    try {
      let bvid: string | undefined;
      let aid: number | undefined;

      // Determine ID type
      if (typeof id === "number" || typeof id === "bigint") {
        aid = Number(id);
      } else if (id.startsWith("BV")) {
        bvid = id;
      } else if (id.toLowerCase().startsWith("av")) {
        aid = parseInt(id.substring(2));
      } else if (!Number.isNaN(Number(id))) {
        aid = Number(id);
      } else {
        // Fallback assumes BVID if string
        bvid = id;
      }

      // 2. Check cache (using BVID or AID) - skip if in repair mode
      const checkId = bvid || aid;
      if (!skipCacheCheck && checkId) {
        const exists = await this.db.hasProcessedVideoById(checkId);
        if (exists) {
          logger.debug(`Video ${checkId} already processed, skipping.`);
          return { video: null, relatedVideos: [] };
        }
      }

      // 3. Fetch details (with concurrency limiting)
      const release = await this.rateLimiter.acquire();
      let videoData: VideoData;
      let relatedVideos: RecommendedVideo[];
      try {
        ({ videoData, relatedVideos } = await this.fetchVideoDetailsWithRelated(
          bvid || aid || 0,
          source,
        ));
      } finally {
        release();
      }

      // Re-check cache using the true BVID from response (useful if we started with AID)
      if (!bvid && videoData.bvid) {
        const exists = await this.db.hasProcessedVideo(videoData.bvid);
        if (exists) {
          logger.debug(
            `Video ${videoData.bvid} (from aid ${aid}) already processed, skipping.`,
          );
          return { video: null, relatedVideos: [] };
        }
      }

      // 4. Filter video
      const filtered = await filterVideo(videoData);

      // 5. Mark as processed in DB
      await this.db.markVideoProcessed(videoData, filtered !== null);

      if (!filtered) {
        return { video: null, relatedVideos: [] };
      }

      // 6. Convert related videos to dynamics for recursive processing
      const relatedDynamics = processRelated
        ? this.convertRelatedToDynamics(relatedVideos)
        : [];

      return { video: filtered, relatedVideos: relatedDynamics };
    } catch (error) {
      // Handle deleted videos gracefully - mark as processed to avoid retrying
      if (
        error instanceof Error &&
        error.message.startsWith("VIDEO_DELETED:")
      ) {
        const bvidFromError = error.message.split(":")[1] || String(id);
        logger.debug(
          `Video ${bvidFromError} has been deleted, marking as processed`,
        );
        await this.db.markVideoDeleted(bvidFromError);
        return { video: null, relatedVideos: [] };
      }

      // Handle videos that are invisible / under review / private (62002/62004/62012)
      if (
        error instanceof Error &&
        error.message.startsWith("VIDEO_UNAVAILABLE:")
      ) {
        const parts = error.message.split(":");
        const bvidFromError = parts[1] || String(id);
        const apiCode = Number(parts[2]);
        const apiMessage = parts.slice(3).join(":") || "";
        logger.debug(
          `Video ${bvidFromError} unavailable (code ${apiCode}: ${apiMessage}), marking as deleted`,
        );
        await this.db.markVideoDeleted(bvidFromError, {
          api_code: apiCode,
          api_message: apiMessage,
        });
        return { video: null, relatedVideos: [] };
      }

      throw error;
    }
  }

  private async resolveForward(dynamic: BiliDynamicCard): Promise<string> {
    const dynamicId = dynamic.desc.dynamic_id;

    // Check cache first
    const cachedBvid = await this.db.getCachedForwardBvid(dynamicId.toString());
    if (cachedBvid) {
      return cachedBvid;
    }

    // Fetch original dynamic
    const release = await this.rateLimiter.acquire();
    try {
      const originalDynamicId =
        dynamic.desc.orig_dy_id_str || dynamic.desc.origin?.dynamic_id_str;
      if (!originalDynamicId) {
        logger.warn(`Cannot find original dynamic ID for forward ${dynamicId}`);
        return "";
      }

      // We might need to fetch the *forward* dynamic itself to get the origin if it's not in the card
      // But usually `desc.origin` or `desc.orig_dy_id_str` has it.
      // If we need to fetch the original dynamic details:
      const response = await getDynamic(originalDynamicId);

      if (response.code !== 0 || !response.data.card) {
        logger.warn(`Failed to fetch original dynamic ${originalDynamicId}`);
        return "";
      }

      const bvid = response.data.card.desc.bvid;
      if (bvid) {
        await this.db.cacheForward(dynamicId.toString(), bvid);
        return bvid;
      }
    } catch (error) {
      logger.error(`Error resolving forward ${dynamicId}:`, error);
    } finally {
      release();
    }

    return "";
  }

  private async fetchVideoDetailsWithRelated(
    id: string | number,
    source: "following" | "recommendation" = "following",
  ): Promise<{
    videoData: VideoData;
    relatedVideos: RecommendedVideo[];
  }> {
    const params = typeof id === "number" ? { aid: id } : { bvid: id };

    // Fetch full details including related videos
    const fullDetail = await fetchVideoFullDetail(params);

    // Handle deleted videos
    if (!fullDetail) {
      throw new Error(`VIDEO_DELETED:${id}`);
    }

    const view = fullDetail.data.View;
    const relatedVideos = fullDetail.data.Related || [];

    let tagString = "";
    tagString = fullDetail.data.Tags.map((t) => t.tag_name).join(";");

    const videoData: VideoData = {
      // Core identifiers
      aid: view.aid,
      bvid: view.bvid,

      // User info
      user_id: view.owner.mid,
      staff: view.staff?.map((s) => BigInt(s.mid)),

      // Category
      type_id: view.tid,
      tid_v2: view.tid_v2,

      // Content
      title: view.title,
      description: view.desc,
      dynamic: view.dynamic || undefined,
      pic: view.pic,
      tag: tagString,
      tag_new: fullDetail.data.Tags?.map((t) => t.tag_name),
      participle: fullDetail.data.participle,

      // Timing
      pubdate: view.pubdate,
      ctime: view.ctime,

      // Flags
      is_deleted: false,
      copyright: view.copyright,

      // Extras
      extras: {
        duration: view.duration,
        videos: view.videos,
        state: view.state,
        cid: view.cid,
        mission_id: view.mission_id,
        ugc_season_id: view.ugc_season?.id,
        dimension: view.dimension,
        rights: view.rights,
        argue_info: view.argue_info,
        honor_reply: view.honor_reply,
      },
    };

    // Extract and store user info
    await this.extractAndStoreUser(fullDetail.data.Card.card, source);

    // Batch write recommendation relationships
    if (relatedVideos.length > 0) {
      const recommendations = relatedVideos.map((v, index) => ({
        videoBvid: v.bvid,
        recommendedByBvid: view.bvid,
        order: index,
      }));
      await this.db.trackRecommendationsBatch(recommendations);
    }

    return { videoData, relatedVideos };
  }

  private async extractAndStoreUser(
    owner: {
      mid: bigint | string;
      name: string;
      face: string;
      fans: number;
    },
    source: "following" | "recommendation" = "following",
  ) {
    const mid = BigInt(owner.mid);
    try {
      const isKnown = await this.db.hasUser(mid);
      if (!isKnown) {
        await this.db.addDiscoveredUser({
          userId: mid,
          userName: owner.name,
          fans: owner.fans,
          source,
          isFollowing: source === "following",
        });
      }
    } catch (e) {
      logger.error(`Failed to store user ${owner.mid}`, e);
    }
  }

  private convertRelatedToDynamics(
    relatedVideos: RecommendedVideo[],
  ): BiliDynamicCard[] {
    return relatedVideos.map(
      (video) =>
        ({
          desc: {
            bvid: video.bvid,
            dynamic_id: 0, // No dynamic ID for related videos
            type: 8, // Video type
            timestamp: video.pubdate,
            user_profile: {
              info: {
                uid: video.owner.mid,
                uname: video.owner.name,
                face: video.owner.face,
              },
            },
            // Fill other necessary fields with defaults or derived data
            uid: video.owner.mid,
            rid: video.tid,
            view: video.stat.view,
            repost: 0,
            comment: 0,
            like: 0,
            is_liked: 0,
            acl: 0,
            status: 1,
          },
          card: JSON.stringify({
            // Minimal card data if needed
            aid: video.aid,
            owner: video.owner,
            pic: video.pic,
            title: video.title,
            stat: video.stat,
          }),
        }) as unknown as BiliDynamicCard,
    );
  }
}
