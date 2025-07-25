import { z } from "zod";

// Content processing features and filtering
export const processingSchema = z.object({
  features: z.object({
    enableTagFetch: z.coerce.boolean().default(false),
    enableUserRelation: z.coerce.boolean().default(false),
    enableDeduplication: z.coerce.boolean().default(true),
  }),
  filtering: z.object({
    typeIdWhitelist: z.array(z.number()).default([]),
    contentBlacklist: z.array(z.string()).default([]),
    contentWhitelist: z.array(z.string()).default([]),
  }),
  deduplication: z.object({
    aidsDuckdbPath: z.string(),
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
    deduplication: {
      aidsDuckdbPath: getConfigValue(
        ["processing", "deduplication", "aids_duckdb_path"],
        "AIDS_DUCKDB_PATH",
        "./data/aids.duckdb",
      ),
    },
  };
}
