import { z } from "zod";

// Database configuration for PostgreSQL
export const databaseSchema = z.object({
  url: z.string(),
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
  };
}
