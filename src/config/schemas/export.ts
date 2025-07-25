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
