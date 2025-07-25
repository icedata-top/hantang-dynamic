import { z } from "zod";

// MySQL export configuration
export const mysqlSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  table: z.string().optional(),
  database: z.string().optional(),
});

export type MysqlConfig = z.infer<typeof mysqlSchema>;

// Factory function to create MySQL config from TOML/env
export function createMysqlConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): MysqlConfig {
  return {
    host: getConfigValue(["export", "mysql", "host"], "MYSQL_IP"),
    port: getConfigValue(["export", "mysql", "port"], "MYSQL_PORT"),
    username: getConfigValue(["export", "mysql", "username"], "MYSQL_USERNAME"),
    password: getConfigValue(["export", "mysql", "password"], "MYSQL_PASSWORD"),
    table: getConfigValue(["export", "mysql", "table"], "MYSQL_TABLE"),
    database: getConfigValue(["export", "mysql", "database"], "MYSQL_DATABASE"),
  };
}
