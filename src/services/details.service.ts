import { getDynamic } from "../api/dynamic";
import { fetchVideoFullDetail } from "../api/video";
import { config } from "../config";
import { Database } from "../core/database";
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
  ): Promise<{
    video: VideoData | null;
    relatedVideos: BiliDynamicCard[];
  }> {
    try {
      // 1. Resolve BVID (handle forwards)
      let bvid = dynamic.desc.bvid;
      if (dynamic.desc.type === 1) {
        // Forward type
        bvid = await this.resolveForward(dynamic);
        if (!bvid) {
          return { video: null, relatedVideos: [] };
        }
      }

      // 2. Check cache
      const exists = await this.db.hasProcessedVideo(bvid);
      if (exists) {
        logger.debug(`Video ${bvid} already processed, skipping.`);
        return { video: null, relatedVideos: [] };
      }

      // 3. Fetch details (with rate limiting)
      await this.rateLimiter.acquire();
      const { videoData, relatedVideos } =
        await this.fetchVideoDetailsWithRelated(bvid);

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
      logger.error(
        `Error processing video from dynamic ${dynamic.desc.dynamic_id}:`,
        error,
      );
      return { video: null, relatedVideos: [] };
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
    try {
      await this.rateLimiter.acquire();
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
    }

    return "";
  }

  private async fetchVideoDetailsWithRelated(bvid: string): Promise<{
    videoData: VideoData;
    relatedVideos: RecommendedVideo[];
  }> {
    // Fetch full details including related videos
    const fullDetail = await fetchVideoFullDetail({ bvid });
    const view = fullDetail.data.View;
    const relatedVideos = fullDetail.data.Related || [];

    let tagString = "";
    tagString = fullDetail.data.Tags.map((t) => t.tag_name).join(";");

    const videoData: VideoData = {
      aid: view.aid,
      bvid: view.bvid,
      pubdate: view.pubdate,
      title: view.title,
      description: view.desc,
      tag: tagString,
      pic: view.pic,
      type_id: view.tid,
      user_id: view.owner.mid,
      copyright: view.copyright,
    };

    // Extract and store user info
    await this.extractAndStoreUser(view.owner);

    return { videoData, relatedVideos };
  }

  private async extractAndStoreUser(owner: {
    mid: bigint;
    name: string;
    face: string;
    fans?: number; // API might not return fans in View.owner, might need separate call if critical
  }) {
    try {
      const isKnown = await this.db.hasUser(BigInt(owner.mid));
      if (!isKnown) {
        await this.db.addDiscoveredUser({
          userId: BigInt(owner.mid),
          userName: owner.name,
          fans: owner.fans || 0,
          source: "following", // Default source
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
