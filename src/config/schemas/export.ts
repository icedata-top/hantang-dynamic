import { z } from "zod";

// CSV export configuration
export const csvSchema = z.object({
  path: z.string(),
});

// DuckDB export configuration
export const duckdbSchema = z.object({
  path: z.string(),
});

// MySQL export configuration
export const mysqlSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  table: z.string().optional(),
  database: z.string().optional(),
});

// Combined export configuration
export const exportSchema = z.object({
  csv: csvSchema,
  duckdb: duckdbSchema,
  mysql: mysqlSchema,
});

export type CsvConfig = z.infer<typeof csvSchema>;
export type DuckdbConfig = z.infer<typeof duckdbSchema>;
export type MysqlConfig = z.infer<typeof mysqlSchema>;
export type ExportConfig = z.infer<typeof exportSchema>;

export function createExportConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): ExportConfig {
  const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
  const defaultCsvPath = bilibiliUid
    ? `./data/uid${bilibiliUid}.csv`
    : "./data/uid.csv";
  const defaultDuckdbPath = bilibiliUid
    ? `./data/uid${bilibiliUid}.duckdb`
    : "./data/uid.duckdb"; 
  return {
    csv: {
      path: getConfigValue(
        ["export", "csv", "path"],
        "CSV_PATH",
        defaultCsvPath,
      ),
    },
    duckdb: {
      path: getConfigValue(
        ["export", "duckdb", "path"],
        "DUCKDB_PATH",
        defaultDuckdbPath,
      ),
    },
    mysql: {
      host: getConfigValue(["export", "mysql", "host"], "MYSQL_IP"),
      port: getConfigValue(["export", "mysql", "port"], "MYSQL_PORT"),
      username: getConfigValue(
        ["export", "mysql", "username"],
        "MYSQL_USERNAME",
      ),
      password: getConfigValue(
        ["export", "mysql", "password"],
        "MYSQL_PASSWORD",
      ),
      table: getConfigValue(["export", "mysql", "table"], "MYSQL_TABLE"),
      database: getConfigValue(
        ["export", "mysql", "database"],
        "MYSQL_DATABASE",
      ),
    },
  };
}
