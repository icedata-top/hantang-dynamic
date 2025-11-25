import { z } from "zod";

// Content processing features and filtering
export const processingSchema = z.object({
  features: z.object({
    enableTagFetch: z.coerce.boolean().default(false),
    enableUserRelation: z.coerce.boolean().default(false),
    enableDeduplication: z.coerce.boolean().default(true),
    enableRecommendation: z.coerce.boolean().default(false),
    maxRecommendationDepth: z.coerce.number().default(1),
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
      enableRecommendation: getConfigValue(
        ["processing", "features", "enable_recommendation"],
        "ENABLE_RECOMMENDATION",
        false,
      ),
      maxRecommendationDepth: getConfigValue(
        ["processing", "features", "max_recommendation_depth"],
        "MAX_RECOMMENDATION_DEPTH",
        1,
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
