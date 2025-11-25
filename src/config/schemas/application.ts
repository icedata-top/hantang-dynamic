import { z } from "zod";

// Application behavior and execution settings
export const applicationSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  fetchInterval: z.coerce.number().default(900_000), // 15 minutes
  apiRetryTimes: z.coerce.number().default(3),
  apiWaitTime: z.coerce.number().default(2000),
  maxHistoryDays: z.coerce.number().default(7),
  maxItem: z.coerce.number().default(0),
});

export type ApplicationConfig = z.infer<typeof applicationSchema>;

export function createApplicationConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): ApplicationConfig {
  return {
    logLevel: getConfigValue(["application", "log_level"], "LOGLEVEL", "info"),
    fetchInterval: getConfigValue(
      ["application", "fetch_interval"],
      "FETCH_INTERVAL",
      900_000,
    ),
    apiRetryTimes: getConfigValue(
      ["application", "api_retry_times"],
      "API_RETRY_TIMES",
      3,
    ),
    apiWaitTime: getConfigValue(
      ["application", "api_wait_time"],
      "API_WAIT_TIME",
      2000,
    ),
    maxHistoryDays: getConfigValue(
      ["application", "max_history_days"],
      "MAX_HISTORY_DAYS",
      7,
    ),
    maxItem: getConfigValue(["application", "max_item"], "MAX_ITEM", 0),
  };
}
