import { z } from "zod";

// Content processing features and filtering
export const processingSchema = z.object({
  features: z.object({
    enableTagFetch: z.coerce.boolean().default(false),
    enableUserRelation: z.coerce.boolean().default(false),
    enableDeduplication: z.coerce.boolean().default(true),
    enableRecommendation: z.coerce.boolean().default(false),
    maxRecommendationDepth: z.coerce.number().default(1),
    enableRelatedQualitySignal: z.coerce.boolean().default(true),
    enableRelatedExpansion: z.coerce.boolean().default(false),
    maxRelatedExpansionDepth: z.coerce.number().default(1),
  }),
  filtering: z.object({
    typeIdWhitelist: z.array(z.number()).default([]),
    contentBlacklist: z.array(z.string()).default([]),
    contentWhitelist: z.array(z.string()).default([]),
    copyrightWhitelist: z.array(z.number()).default([]),
  }),
});

export type ProcessingConfig = z.infer<typeof processingSchema>;

export function createProcessingConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): ProcessingConfig {
  const legacyEnableRecommendation = getConfigValue(
    ["processing", "features", "enable_recommendation"],
    "ENABLE_RECOMMENDATION",
  );
  const legacyMaxRecommendationDepth = getConfigValue(
    ["processing", "features", "max_recommendation_depth"],
    "MAX_RECOMMENDATION_DEPTH",
  );

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
      enableRecommendation: legacyEnableRecommendation ?? false,
      maxRecommendationDepth: legacyMaxRecommendationDepth ?? 1,
      enableRelatedQualitySignal: getConfigValue(
        ["processing", "features", "enable_related_quality_signal"],
        "ENABLE_RELATED_QUALITY_SIGNAL",
        true,
      ),
      enableRelatedExpansion:
        getConfigValue(
          ["processing", "features", "enable_related_expansion"],
          "ENABLE_RELATED_EXPANSION",
        ) ??
        legacyEnableRecommendation ??
        false,
      maxRelatedExpansionDepth:
        getConfigValue(
          ["processing", "features", "max_related_expansion_depth"],
          "MAX_RELATED_EXPANSION_DEPTH",
        ) ??
        legacyMaxRecommendationDepth ??
        1,
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
      copyrightWhitelist:
        getConfigValue(
          ["processing", "filtering", "copyright_whitelist"],
          "COPYRIGHT_WHITE_LIST",
        ) ||
        process.env.COPYRIGHT_WHITE_LIST?.split(",").map(Number) ||
        [],
    },
  };
}
