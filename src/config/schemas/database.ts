import { z } from "zod";

// Database configuration for PostgreSQL
export const databaseSchema = z.object({
  url: z.string(),
  videoDailyMysqlUrl: z.string().optional(),
  schema: z.string().default("public"),
  poolSize: z.coerce.number().int().min(1).default(20),
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
  return {
    videoDailyMysqlUrl: getConfigValue(
      ["database", "video_daily_mysql_url"],
      "VIDEO_DAILY_MYSQL_URL",
    ),
    url: getConfigValue(
      ["database", "url"],
      "DATABASE_URL",
      "postgresql://localhost:5432/hantang",
    ),
    schema: getConfigValue(["database", "schema"], "DATABASE_SCHEMA", "public"),
    poolSize: getConfigValue(
      ["database", "pool_size"],
      "DATABASE_POOL_SIZE",
      20,
    ),
  };
}
