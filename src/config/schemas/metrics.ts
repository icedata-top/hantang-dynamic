import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const metricsSchema = z.object({
  enabled: configBoolean.default(false),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(9469),
  path: z.string().startsWith("/").default("/metrics"),
  collectDefaultMetrics: configBoolean.default(true),
  authToken: z.string().optional(),
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
    host: getConfigValue(["metrics", "host"], "METRICS_HOST", "127.0.0.1"),
    port: getConfigValue(["metrics", "port"], "METRICS_PORT", 9469),
    path: getConfigValue(["metrics", "path"], "METRICS_PATH", "/metrics"),
    collectDefaultMetrics: getConfigValue(
      ["metrics", "collect_default_metrics"],
      "METRICS_COLLECT_DEFAULT",
      true,
    ),
    authToken: getConfigValue(
      ["metrics", "auth_token"],
      "METRICS_AUTH_TOKEN",
      undefined,
    ),
  });
}
