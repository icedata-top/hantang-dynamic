import { z } from "zod";

// Database configuration
export const databaseSchema = z.object({
  path: z.string(),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;

// Factory function to create Database config from TOML/env
export function createDatabaseConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): DatabaseConfig {
  const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
  const defaultDuckdbPath = bilibiliUid
    ? `./exports/duckdb/${bilibiliUid}.duckdb`
    : "./exports/duckdb/default.duckdb";

  return {
    path: getConfigValue(
      ["database", "path"],
      "DATABASE_PATH",
      defaultDuckdbPath,
    ),
  };
}
