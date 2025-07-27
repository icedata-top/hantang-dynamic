import { z } from "zod";

// Content processing features and filtering
export const processingSchema = z.object({
  features: z.object({
    enableTagFetch: z.coerce.boolean().default(false),
    enableUserRelation: z.coerce.boolean().default(false),
    enableDeduplication: z.coerce.boolean().default(true),
    enableRelatedVideos: z.coerce.boolean().default(false),
  }),
  relatedVideos: z.object({
    maxPerVideo: z.coerce.number().default(10),
    maxDepth: z.coerce.number().default(1),
    respectMainFilters: z.coerce.boolean().default(true),
    rateLimitDelay: z.coerce.number().default(1000),
    batchSize: z.coerce.number().default(5),
  }),
  filtering: z.object({
    typeIdWhitelist: z.array(z.number()).default([]),
    contentBlacklist: z.array(z.string()).default([]),
    contentWhitelist: z.array(z.string()).default([]),
  }),
});

export type ProcessingConfig = z.infer<typeof processingSchema>;

export function createProcessingConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): ProcessingConfig {
  return {
    features: {
      enableTagFetch: getConfigValue(
        ["processing", "features", "enable_tag_fetch"],
        "ENABLE_TAG_FETCH",
        false,
      ),
      enableUserRelation: getConfigValue(
        ["processing", "features", "enable_user_relation"],
        "ENABLE_USER_RELATION",
        false,
      ),
      enableDeduplication: getConfigValue(
        ["processing", "features", "enable_deduplication"],
        "ENABLE_DEDUPLICATION",
        true,
      ),
      enableRelatedVideos: getConfigValue(
        ["processing", "features", "enable_related_videos"],
        "ENABLE_RELATED_VIDEOS",
        false,
      ),
    },
    relatedVideos: {
      maxPerVideo: getConfigValue(
        ["processing", "related_videos", "max_per_video"],
        "RELATED_VIDEOS_MAX_PER_VIDEO",
        10,
      ),
      maxDepth: getConfigValue(
        ["processing", "related_videos", "max_depth"],
        "RELATED_VIDEOS_MAX_DEPTH",
        1,
      ),
      respectMainFilters: getConfigValue(
        ["processing", "related_videos", "respect_main_filters"],
        "RELATED_VIDEOS_RESPECT_MAIN_FILTERS",
        true,
      ),
      rateLimitDelay: getConfigValue(
        ["processing", "related_videos", "rate_limit_delay"],
        "RELATED_VIDEOS_RATE_LIMIT_DELAY",
        1000,
      ),
      batchSize: getConfigValue(
        ["processing", "related_videos", "batch_size"],
        "RELATED_VIDEOS_BATCH_SIZE",
        5,
      ),
    },
    filtering: {
      typeIdWhitelist:
        getConfigValue(
          ["processing", "filtering", "type_id_whitelist"],
          "TYPE_ID_WHITE_LIST",
        ) ||
        process.env.TYPE_ID_WHITE_LIST?.split(",").map(Number) ||
        [],
      contentBlacklist:
        getConfigValue(
          ["processing", "filtering", "content_blacklist"],
          "CONTENT_BLACK_LIST",
        ) ||
        process.env.CONTENT_BLACK_LIST?.split(",").map((s) => s.trim()) ||
        [],
      contentWhitelist:
        getConfigValue(
          ["processing", "filtering", "content_whitelist"],
          "CONTENT_WHITE_LIST",
        ) ||
        process.env.CONTENT_WHITE_LIST?.split(",").map((s) => s.trim()) ||
        [],
    },
  };
}
