import { z } from "zod";
import { createMysqlConfig, mysqlSchema } from "./mysql";

// Combined export configuration
export const exportSchema = z.object({
  mysql: mysqlSchema,
});

export type ExportConfig = z.infer<typeof exportSchema>;

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
    mysql: createMysqlConfig(getConfigValue),
  };
}
