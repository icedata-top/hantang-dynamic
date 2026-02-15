import { getDynamic } from "../api/dynamic";
import { fetchVideoFullDetail } from "../api/video";
import { config } from "../config";
import { Database } from "../database";
import type { BiliDynamicCard, RecommendedVideo, VideoData } from "../types";
import type { DynamicData } from "../types/models/database";
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
   * For forward dynamics (type=1), also stores the forwarder as a discovered user.
   */
  async processVideo(
    dynamic: BiliDynamicCard,
    processRelated = true,
  ): Promise<{
    video: VideoData | null;
    relatedVideos: BiliDynamicCard[];
  }> {
    let bvid = dynamic.desc.bvid;
    try {
      if (dynamic.desc.type === 1) {
        // Forward type: save the forwarder, then process the original video.
        // Dynamic content is saved inside resolveForward once the bvid is known.
        await this.storeForwarder(dynamic);
        bvid = await this.resolveForward(dynamic);
        if (!bvid) {
          return { video: null, relatedVideos: [] };
        }
      }

      return await this.processVideoById(bvid, { processRelated });
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
    } = {},
  ): Promise<{
    video: VideoData | null;
    relatedVideos: BiliDynamicCard[];
  }> {
    const { processRelated = true, skipCacheCheck = false } = options;

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

  /**
   * Store the user who forwarded a dynamic (type=1).
   * The forwarder is someone we follow — their info comes from dynamic.desc.
   */
  private async storeForwarder(dynamic: BiliDynamicCard): Promise<void> {
    const uid = dynamic.desc.uid;
    const profile = dynamic.desc.user_profile?.info;
    if (!uid || !profile) return;

    await this.storeUser({
      mid: uid,
      name: profile.uname,
      face: profile.face,
      fans: 0,
    });
  }

  private async resolveForward(dynamic: BiliDynamicCard): Promise<string> {
    const dynamicId = dynamic.desc.dynamic_id;

    const cachedBvid = await this.db.getCachedForwardBvid(dynamicId.toString());
    if (cachedBvid) {
      return cachedBvid;
    }

    const release = await this.rateLimiter.acquire();
    try {
      const originalDynamicId =
        dynamic.desc.orig_dy_id_str || dynamic.desc.origin?.dynamic_id_str;
      if (!originalDynamicId) {
        logger.warn(`Cannot find original dynamic ID for forward ${dynamicId}`);
        return "";
      }

      const response = await getDynamic(originalDynamicId);

      if (response.code !== 0 || !response.data.card) {
        logger.warn(`Failed to fetch original dynamic ${originalDynamicId}`);
        return "";
      }

      const bvid = response.data.card.desc.bvid;
      if (bvid) {
        // Save the full dynamic content with the resolved bvid.
        // This also serves as the forward→bvid cache entry in the dynamics table.
        await this.saveDynamic(dynamic, bvid);
        return bvid;
      }
    } catch (error) {
      logger.error(`Error resolving forward ${dynamicId}:`, error);
    } finally {
      release();
    }

    return "";
  }

  private async fetchVideoDetailsWithRelated(id: string | number): Promise<{
    videoData: VideoData;
    relatedVideos: RecommendedVideo[];
  }> {
    const params = typeof id === "number" ? { aid: id } : { bvid: id };

    const fullDetail = await fetchVideoFullDetail(params);

    if (!fullDetail) {
      throw new Error(`VIDEO_DELETED:${id}`);
    }

    const view = fullDetail.data.View;
    const relatedVideos = fullDetail.data.Related || [];

    const tagString = fullDetail.data.Tags.map((t) => t.tag_name).join(";");

    const videoData: VideoData = {
      aid: view.aid,
      bvid: view.bvid,
      user_id: view.owner.mid,
      staff: view.staff?.map((s) => BigInt(s.mid)),
      type_id: view.tid,
      tid_v2: view.tid_v2,
      title: view.title,
      description: view.desc,
      dynamic: view.dynamic || undefined,
      pic: view.pic,
      tag: tagString,
      tag_new: fullDetail.data.Tags?.map((t) => t.tag_name),
      participle: fullDetail.data.participle,
      pubdate: view.pubdate,
      ctime: view.ctime,
      is_deleted: false,
      copyright: view.copyright,
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

    // Store the video owner (may or may not be someone we follow directly)
    const cardInfo = fullDetail.data.Card.card;
    await this.storeUser({
      mid: cardInfo.mid,
      name: cardInfo.name,
      face: cardInfo.face,
      fans: cardInfo.fans,
      sign: cardInfo.sign || undefined,
      level: cardInfo.level_info?.current_level,
      officialRole: cardInfo.Official?.type,
      officialTitle: cardInfo.Official?.title || undefined,
    });

    if (relatedVideos.length > 0) {
      const recommendations = relatedVideos.map((v, index) => ({
        videoAid: v.aid,
        recommendedByAid: view.aid,
        order: index,
      }));
      await this.db.trackRecommendationsBatch(recommendations);
    }

    return { videoData, relatedVideos };
  }

  /**
   * Store a user in discovered_users if not already known.
   * is_following / followed_by are managed by syncFollowingStatus, not here.
   */
  private async storeUser(owner: {
    mid: bigint | string;
    name: string;
    face: string;
    fans: number;
    sign?: string;
    level?: number;
    officialRole?: number;
    officialTitle?: string;
  }) {
    const mid = BigInt(owner.mid);
    try {
      await this.db.addDiscoveredUser({
        userId: mid,
        userName: owner.name,
        face: owner.face,
        fans: owner.fans,
        sign: owner.sign,
        level: owner.level,
        officialRole: owner.officialRole,
        officialTitle: owner.officialTitle,
      });
    } catch (e) {
      logger.error(`Failed to store user ${owner.mid}`, e);
    }
  }

  /**
   * Parse a BiliDynamicCard and save its content to the dynamics table.
   * For type=1 (forward), pass `resolvedBvid` once it has been fetched from the API
   * so that the entry also acts as a forward→bvid cache.
   */
  async saveDynamic(
    dynamic: BiliDynamicCard,
    resolvedBvid?: string,
  ): Promise<void> {
    try {
      let card: Record<string, unknown> | undefined;
      let extendJson: Record<string, unknown> | undefined;

      try {
        card = JSON.parse(dynamic.card) as Record<string, unknown>;
      } catch {
        // card is not valid JSON; store nothing
      }

      try {
        if (dynamic.extend_json) {
          extendJson = JSON.parse(dynamic.extend_json) as Record<
            string,
            unknown
          >;
        }
      } catch {
        // extend_json is not valid JSON; store nothing
      }

      let textContent: string | undefined;
      let forwardText: string | undefined;
      let images:
        | Array<{ img_src: string; img_width?: number; img_height?: number }>
        | undefined;

      if (card) {
        const item = card.item as Record<string, unknown> | undefined;
        switch (dynamic.desc.type) {
          case 8: // Video post — caption text lives in card.dynamic
            textContent = (card.dynamic as string | undefined) || undefined;
            break;
          case 1: // Forward — text written by the forwarder
            forwardText = (item?.content as string | undefined) || undefined;
            break;
          case 2: // Image post
            textContent =
              (item?.description as string | undefined) || undefined;
            images =
              (item?.pictures as
                | Array<{
                    img_src: string;
                    img_width?: number;
                    img_height?: number;
                  }>
                | undefined) || undefined;
            break;
          case 4: // Text-only post
            textContent = (item?.content as string | undefined) || undefined;
            break;
        }
      }

      const bvid =
        resolvedBvid ||
        (dynamic.desc.bvid ? dynamic.desc.bvid : undefined) ||
        (dynamic.desc.origin?.bvid ? dynamic.desc.origin.bvid : undefined);

      const origDyId =
        dynamic.desc.orig_dy_id && dynamic.desc.orig_dy_id !== BigInt(0)
          ? dynamic.desc.orig_dy_id
          : undefined;

      const origType =
        dynamic.desc.orig_type && dynamic.desc.orig_type !== BigInt(0)
          ? Number(dynamic.desc.orig_type)
          : undefined;

      const data: DynamicData = {
        dynamicId: dynamic.desc.dynamic_id,
        userId: dynamic.desc.uid,
        type: dynamic.desc.type,
        timestamp: dynamic.desc.timestamp,
        bvid,
        origDynamicId: origDyId,
        origType,
        textContent,
        forwardText,
        images,
        card,
        extendJson,
      };

      await this.db.saveDynamic(data);
    } catch (error) {
      logger.error(`Failed to save dynamic ${dynamic.desc.dynamic_id}:`, error);
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
            dynamic_id: 0,
            type: 8,
            timestamp: video.pubdate,
            user_profile: {
              info: {
                uid: video.owner.mid,
                uname: video.owner.name,
                face: video.owner.face,
              },
            },
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
