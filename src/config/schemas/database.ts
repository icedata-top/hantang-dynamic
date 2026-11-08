import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

// Database configuration for PostgreSQL
export const databaseSchema = z.object({
  url: z.string(),
  schema: z.string().default("public"),
  poolSize: z.coerce.number().int().min(1).default(20),
  pruneVideoDailySource: configBoolean.default(false),
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
    pruneVideoDailySource: getConfigValue(
      ["database", "prune_video_daily_source"],
      "DATABASE_PRUNE_VIDEO_DAILY_SOURCE",
      false,
    ),
  };
}
