import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const minuteSchema = z.object({
  enabled: configBoolean.default(false),
  claimBatchSize: z.coerce.number().int().positive().default(50),
  batchSize: z.coerce.number().int().positive().default(50),
  targetDeltaPerSample: z.coerce.number().int().positive().default(100),
  targetDeltaLower: z.coerce.number().int().positive().default(50),
  targetDeltaUpper: z.coerce.number().int().positive().default(200),
  minPositivePriority: z.coerce.number().int().positive().default(1),
  maxPositivePriority: z.coerce.number().int().positive().default(720),
  bootstrapPriority: z.coerce.number().int().positive().default(10),
  bootstrapTtlHours: z.coerce.number().int().positive().max(24).default(24),
  bootstrapLabelContentTypes: z
    .array(z.string())
    .default(["vocaloid", "maybe_vocaloid"]),
  bootstrapLabelOrigin: z.string().default("rule"),
  bootstrapLabelWriters: z
    .array(z.string())
    .default(["classification_apply", "classification_trigger"]),
  bootstrapTidV2Allowlist: z
    .array(z.coerce.number().int())
    .default([2022, 2061]),
  minuteBurstDeltaThreshold: z.coerce.number().int().positive().default(500),
  minuteBurstPriority: z.coerce.number().int().positive().default(1),
  processedBackfillNewVideoAgeDays: z.coerce
    .number()
    .int()
    .positive()
    .default(7),
  collectionBusinessTimezone: z.string().default("Asia/Shanghai"),
});

export type MinuteConfig = z.infer<typeof minuteSchema>;

export function createMinuteConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): MinuteConfig {
  const raw = {
    enabled: getConfigValue(["minute", "enabled"], "MINUTE_ENABLED", false),
    claimBatchSize: getConfigValue(
      ["minute", "claim_batch_size"],
      "MINUTE_CLAIM_BATCH_SIZE",
      50,
    ),
    batchSize: getConfigValue(
      ["minute", "batch_size"],
      "MINUTE_BATCH_SIZE",
      50,
    ),
    targetDeltaPerSample: getConfigValue(
      ["minute", "target_delta_per_sample"],
      "MINUTE_TARGET_DELTA_PER_SAMPLE",
      100,
    ),
    targetDeltaLower: getConfigValue(
      ["minute", "target_delta_lower"],
      "MINUTE_TARGET_DELTA_LOWER",
      50,
    ),
    targetDeltaUpper: getConfigValue(
      ["minute", "target_delta_upper"],
      "MINUTE_TARGET_DELTA_UPPER",
      200,
    ),
    minPositivePriority: getConfigValue(
      ["minute", "min_positive_priority"],
      "MINUTE_MIN_POSITIVE_PRIORITY",
      1,
    ),
    maxPositivePriority: getConfigValue(
      ["minute", "max_positive_priority"],
      "MINUTE_MAX_POSITIVE_PRIORITY",
      720,
    ),
    bootstrapPriority: getConfigValue(
      ["minute", "bootstrap_priority"],
      "MINUTE_BOOTSTRAP_PRIORITY",
      10,
    ),
    bootstrapTtlHours: getConfigValue(
      ["minute", "bootstrap_ttl_hours"],
      "MINUTE_BOOTSTRAP_TTL_HOURS",
      24,
    ),
    bootstrapLabelContentTypes: getConfigValue(
      ["minute", "bootstrap_label_content_types"],
      "MINUTE_BOOTSTRAP_LABEL_CONTENT_TYPES",
      ["vocaloid", "maybe_vocaloid"],
    ),
    bootstrapLabelOrigin: getConfigValue(
      ["minute", "bootstrap_label_origin"],
      "MINUTE_BOOTSTRAP_LABEL_ORIGIN",
      "rule",
    ),
    bootstrapLabelWriters: getConfigValue(
      ["minute", "bootstrap_label_writers"],
      "MINUTE_BOOTSTRAP_LABEL_WRITERS",
      ["classification_apply", "classification_trigger"],
    ),
    bootstrapTidV2Allowlist: getConfigValue(
      ["minute", "bootstrap_tid_v2_allowlist"],
      "MINUTE_BOOTSTRAP_TID_V2_ALLOWLIST",
      [2022, 2061],
    ),
    minuteBurstDeltaThreshold: getConfigValue(
      ["minute", "minute_burst_delta_threshold"],
      "MINUTE_BURST_DELTA_THRESHOLD",
      500,
    ),
    minuteBurstPriority: getConfigValue(
      ["minute", "minute_burst_priority"],
      "MINUTE_BURST_PRIORITY",
      1,
    ),
    processedBackfillNewVideoAgeDays: getConfigValue(
      ["minute", "processed_backfill_new_video_age_days"],
      "MINUTE_PROCESSED_BACKFILL_NEW_VIDEO_AGE_DAYS",
      7,
    ),
    collectionBusinessTimezone: getConfigValue(
      ["minute", "collection_business_timezone"],
      "MINUTE_COLLECTION_BUSINESS_TIMEZONE",
      "Asia/Shanghai",
    ),
  };

  const config = minuteSchema.parse(raw);
  const effectiveTarget = Math.min(
    Math.max(config.targetDeltaPerSample, config.targetDeltaLower),
    config.targetDeltaUpper,
  );

  return {
    ...config,
    targetDeltaPerSample: effectiveTarget,
  };
}
