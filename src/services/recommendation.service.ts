import { Database } from "../core/database";
import type { BiliDynamicCard } from "../types";
import { logger } from "../utils/logger";

export class RecommendationService {
  private db: Database;

  constructor() {
    this.db = Database.getInstance();
  }

  /**
   * Track recommendations from a source video and convert them to dynamic format
   * for recursive processing.
   */
  async trackAndConvertRecommendations(
    sourceBvid: string,
    relatedVideos: BiliDynamicCard[],
  ): Promise<BiliDynamicCard[]> {
    const converted: BiliDynamicCard[] = [];

    for (let i = 0; i < relatedVideos.length; i++) {
      const dynamic = relatedVideos[i];
      const targetBvid = dynamic.desc.bvid;

      try {
        // 1. Track recommendation relationship
        await this.db.trackRecommendation(targetBvid, sourceBvid, i + 1);

        // 2. Track user discovery (handled in DetailsService when processing the video,
        //    but we can also do a quick check here if we want to track 'recommendation' source specifically)
        //    Actually, DetailsService handles user discovery when it fetches details.
        //    But here we know it came from a recommendation.
        //    Let's update the user source if they are new.

        //    We can't easily update source if they already exist without a specific method,
        //    but `addDiscoveredUser` handles new users.
        //    We'll leave user discovery to DetailsService for now to avoid double DB calls,
        //    or we could pass context to DetailsService.
        //    For now, let's just return the dynamic for processing.

        converted.push(dynamic);
      } catch (error) {
        logger.error(
          `Error tracking recommendation ${sourceBvid} -> ${targetBvid}:`,
          error,
        );
      }
    }

    return converted;
  }
}
