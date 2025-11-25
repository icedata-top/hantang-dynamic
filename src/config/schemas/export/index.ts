import { z } from "zod";
import { createCsvConfig, csvSchema } from "./csv";
import { createDuckdbConfig, duckdbSchema } from "./duckdb";
import { createMysqlConfig, mysqlSchema } from "./mysql";

// Combined export configuration
export const exportSchema = z.object({
  csv: csvSchema,
  duckdb: duckdbSchema,
  mysql: mysqlSchema,
});

export type ExportConfig = z.infer<typeof exportSchema>;

// Re-export individual types
export type { CsvConfig } from "./csv";
export type { DuckdbConfig } from "./duckdb";
export type { MysqlConfig } from "./mysql";

// Factory function to create export config from TOML/env
export function createExportConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): ExportConfig {
  return {
    csv: createCsvConfig(getConfigValue),
    duckdb: createDuckdbConfig(getConfigValue),
    mysql: createMysqlConfig(getConfigValue),
  };
}
