import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const metricsSchema = z.object({
  enabled: configBoolean.default(false),
  path: z.string().startsWith("/").default("/metrics"),
  collectDefaultMetrics: configBoolean.default(true),
});

export type MetricsConfig = z.infer<typeof metricsSchema>;

export function createMetricsConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): MetricsConfig {
  return metricsSchema.parse({
    enabled: getConfigValue(["metrics", "enabled"], "METRICS_ENABLED", false),
    path: getConfigValue(["metrics", "path"], "METRICS_PATH", "/metrics"),
    collectDefaultMetrics: getConfigValue(
      ["metrics", "collect_default_metrics"],
      "METRICS_COLLECT_DEFAULT",
      true,
    ),
  });
}
