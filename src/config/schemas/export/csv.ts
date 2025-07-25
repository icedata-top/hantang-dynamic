import { z } from "zod";

// CSV export configuration
export const csvSchema = z.object({
  path: z.string(),
});

export type CsvConfig = z.infer<typeof csvSchema>;

// Factory function to create CSV config from TOML/env
export function createCsvConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): CsvConfig {
  const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
  const defaultCsvPath = bilibiliUid
    ? `/exports/csv/${bilibiliUid}.csv`
    : "/exports/csv/default.csv";
  return {
    path: getConfigValue(["export", "csv", "path"], "CSV_PATH", defaultCsvPath),
  };
}
