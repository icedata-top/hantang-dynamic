import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const subtitleSchema = z.object({
  enabled: configBoolean.default(false),
  viewThreshold: z.coerce.number().int().positive().default(10_000),
  fetchIntervalMs: z.coerce.number().int().positive().default(60_000),
  maxRetries: z.coerce.number().int().positive().default(3),
});

export type SubtitleConfig = z.infer<typeof subtitleSchema>;

export function createSubtitleConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): SubtitleConfig {
  return subtitleSchema.parse({
    enabled: getConfigValue(["subtitle", "enabled"], "SUBTITLE_ENABLED", false),
    viewThreshold: getConfigValue(
      ["subtitle", "view_threshold"],
      "SUBTITLE_VIEW_THRESHOLD",
      10_000,
    ),
    fetchIntervalMs: getConfigValue(
      ["subtitle", "fetch_interval_ms"],
      "SUBTITLE_FETCH_INTERVAL_MS",
      60_000,
    ),
    maxRetries: getConfigValue(
      ["subtitle", "max_retries"],
      "SUBTITLE_MAX_RETRIES",
      3,
    ),
  });
}
