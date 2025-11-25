import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  applicationSchema,
  bilibiliSchema,
  createApplicationConfig,
  createBilibiliConfig,
  createExportConfig,
  createNotificationsConfig,
  createProcessingConfig,
  exportSchema,
  notificationsSchema,
  processingSchema,
} from "./schemas";

let tomlData: unknown = {};
try {
  const configPath = resolve(process.cwd(), "config.toml");
  const tomlString = readFileSync(configPath, "utf-8");
  tomlData = parseToml(tomlString);
} catch (_error) {
  console.warn(
    "Warning: config.toml not found or invalid. Using environment variables as fallback.",
  );
}

// Helper function to get configuration value from TOML or environment variable
function getConfigValue(
  tomlPath: string[],
  envKey: string,
  // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  defaultValue?: any,
  // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
): any {
  try {
    // Try to get value from TOML first
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    let value: any = tomlData;
    for (const key of tomlPath) {
      if (value && typeof value === "object" && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        value = undefined;
        break;
      }
    }

    // If found in TOML and not empty string, return it
    if (value !== undefined && value !== "") {
      return value;
    }
  } catch (_e) {
    // Ignore TOML parsing errors for individual values
  }

  // Fallback to environment variable
  const envValue = process.env[envKey];
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  // Return default value
  return defaultValue;
}

const configSchema = z.object({
  bilibili: bilibiliSchema,
  application: applicationSchema,
  processing: processingSchema,
  export: exportSchema,
  notifications: notificationsSchema,
});

export const config = configSchema.parse({
  bilibili: createBilibiliConfig(getConfigValue),
  application: createApplicationConfig(getConfigValue),
  processing: createProcessingConfig(getConfigValue),
  export: createExportConfig(getConfigValue),
  notifications: createNotificationsConfig(getConfigValue),
});

export type Config = z.infer<typeof configSchema>;

// Re-export all types and schemas for convenience
export * from "./schemas";
