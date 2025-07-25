import { z } from "zod";
import { csvSchema, createCsvConfig } from "./csv";
import { duckdbSchema, createDuckdbConfig } from "./duckdb";
import { mysqlSchema, createMysqlConfig } from "./mysql";

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
    defaultValue?: any,
  ) => any,
): ExportConfig {
  return {
    csv: createCsvConfig(getConfigValue),
    duckdb: createDuckdbConfig(getConfigValue),
    mysql: createMysqlConfig(getConfigValue),
  };
}
