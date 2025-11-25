import { z } from "zod";

// DuckDB export configuration
export const duckdbSchema = z.object({
  enabled: z.boolean().optional().default(false),
  path: z.string(),
});

export type DuckdbConfig = z.infer<typeof duckdbSchema>;

// Factory function to create DuckDB config from TOML/env
export function createDuckdbConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): DuckdbConfig {
  const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
  const defaultDuckdbPath = bilibiliUid
    ? `/exports/duckdb/${bilibiliUid}.duckdb`
    : "/exports/duckdb/default.duckdb";
  return {
    enabled: getConfigValue(
      ["export", "duckdb", "enabled"],
      "DUCKDB_ENABLED",
      false,
    ),
    path: getConfigValue(
      ["export", "duckdb", "path"],
      "DUCKDB_PATH",
      defaultDuckdbPath,
    ),
  };
}
