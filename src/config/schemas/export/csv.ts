import { z } from "zod";

// CSV export configuration
export const csvSchema = z.object({
  enabled: z.boolean().optional().default(false),
  path: z.string(),
});

export type CsvConfig = z.infer<typeof csvSchema>;

// Factory function to create CSV config from TOML/env
export function createCsvConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): CsvConfig {
  const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
  const defaultCsvPath = bilibiliUid
    ? `/exports/csv/${bilibiliUid}.csv`
    : "/exports/csv/default.csv";
  return {
    enabled: getConfigValue(["export", "csv", "enabled"], "CSV_ENABLED", false),
    path: getConfigValue(["export", "csv", "path"], "CSV_PATH", defaultCsvPath),
  };
}
