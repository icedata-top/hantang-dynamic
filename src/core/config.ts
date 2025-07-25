import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

let tomlData: any = {};
try {
  const configPath = resolve(process.cwd(), "config.toml");
  const tomlString = readFileSync(configPath, "utf-8");
  tomlData = parseToml(tomlString);
} catch (error) {
  console.warn(
    "Warning: config.toml not found or invalid. Using environment variables as fallback.",
  );
}

const envSchema = z.object({
  BILIBILI_UID: z.string().min(1),
  SESSDATA: z.string().min(1),
  BILI_JCT: z.string().optional(), // Add CSRF token for user relation operations
  BILI_ACCESS_KEY: z.string().optional(), // Add access key for app authentication
  LOGLEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  FETCH_INTERVAL: z.coerce.number().default(900_000), // 15 minutes
  API_RETRY_TIMES: z.coerce.number().default(3),
  API_WAIT_TIME: z.coerce.number().default(2000),
  MAX_HISTORY_DAYS: z.coerce.number().default(7),
  MAX_ITEM: z.coerce.number().default(0),
  ENABLE_TAG_FETCH: z.coerce.boolean().default(false),
  ENABLE_USER_RELATION: z.coerce.boolean().default(false), // Toggle for user relation features
  TYPE_ID_WHITE_LIST: z.array(z.number()).default([]),
  CONTENT_BLACK_LIST: z.array(z.string()).default([]), // Add content blacklist keywords
  CONTENT_WHITE_LIST: z.array(z.string()).default([]), // Add content whitelist keywords

  MYSQL_IP: z.string().optional(),
  MYSQL_PORT: z.coerce.number().optional(),
  MYSQL_USERNAME: z.string().optional(),
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_TABLE: z.string().optional(),
  MYSQL_DATABASE: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.coerce.number().optional(),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TO: z.string().optional(),

  CSV_PATH: z.string(),
  DUCKDB_PATH: z.string(),
  AIDS_DUCKDB_PATH: z.string(),
});

export type EnvConfig = z.infer<typeof envSchema>;

// Helper function to get configuration value from TOML or environment variable
function getConfigValue(
  tomlPath: string[],
  envKey: string,
  defaultValue?: any,
): any {
  try {
    // Try to get value from TOML first
    let value = tomlData;
    for (const key of tomlPath) {
      value = value?.[key];
    }

    // If found in TOML and not empty string, return it
    if (value !== undefined && value !== "") {
      return value;
    }
  } catch (e) {
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

// Generate default paths based on UID
const bilibiliUid = getConfigValue(
  ["input", "bilibili", "uid"],
  "BILIBILI_UID",
);
const defaultCsvPath = bilibiliUid
  ? `./data/uid${bilibiliUid}.csv`
  : "./data/uid.csv";
const defaultDuckdbPath = bilibiliUid
  ? `./data/uid${bilibiliUid}.duckdb`
  : "./data/uid.duckdb";
const defaultAidsDuckdbPath = "./data/aids.duckdb";

export const config: EnvConfig = envSchema.parse({
  BILIBILI_UID: getConfigValue(["input", "bilibili", "uid"], "BILIBILI_UID"),
  SESSDATA: getConfigValue(["input", "bilibili", "sessdata"], "SESSDATA"),
  BILI_JCT: getConfigValue(["input", "bilibili", "csrf_token"], "BILI_JCT"),
  BILI_ACCESS_KEY: getConfigValue(
    ["input", "bilibili", "access_key"],
    "BILI_ACCESS_KEY",
  ),

  LOGLEVEL: getConfigValue(
    ["input", "application", "log_level"],
    "LOGLEVEL",
    "info",
  ),
  FETCH_INTERVAL: getConfigValue(
    ["input", "application", "fetch_interval"],
    "FETCH_INTERVAL",
    900_000,
  ),
  API_RETRY_TIMES: getConfigValue(
    ["input", "application", "api_retry_times"],
    "API_RETRY_TIMES",
    3,
  ),
  API_WAIT_TIME: getConfigValue(
    ["input", "application", "api_wait_time"],
    "API_WAIT_TIME",
    2000,
  ),
  MAX_HISTORY_DAYS: getConfigValue(
    ["input", "application", "max_history_days"],
    "MAX_HISTORY_DAYS",
    7,
  ),
  MAX_ITEM: getConfigValue(["input", "application", "max_item"], "MAX_ITEM", 0),
  ENABLE_TAG_FETCH: getConfigValue(
    ["processing", "features", "enable_tag_fetch"],
    "ENABLE_TAG_FETCH",
    false,
  ),
  ENABLE_USER_RELATION: getConfigValue(
    ["processing", "features", "enable_user_relation"],
    "ENABLE_USER_RELATION",
    false,
  ),
  TYPE_ID_WHITE_LIST:
    getConfigValue(
      ["processing", "filtering", "type_id_whitelist"],
      "TYPE_ID_WHITE_LIST",
    ) ||
    process.env.TYPE_ID_WHITE_LIST?.split(",").map(Number) ||
    [],
  CONTENT_BLACK_LIST:
    getConfigValue(
      ["processing", "filtering", "content_blacklist"],
      "CONTENT_BLACK_LIST",
    ) ||
    process.env.CONTENT_BLACK_LIST?.split(",").map((s) => s.trim()) ||
    [],
  CONTENT_WHITE_LIST:
    getConfigValue(
      ["processing", "filtering", "content_whitelist"],
      "CONTENT_WHITE_LIST",
    ) ||
    process.env.CONTENT_WHITE_LIST?.split(",").map((s) => s.trim()) ||
    [],

  MYSQL_IP: getConfigValue(["output", "database", "host"], "MYSQL_IP"),
  MYSQL_PORT: getConfigValue(["output", "database", "port"], "MYSQL_PORT"),
  MYSQL_USERNAME: getConfigValue(
    ["output", "database", "username"],
    "MYSQL_USERNAME",
  ),
  MYSQL_PASSWORD: getConfigValue(
    ["output", "database", "password"],
    "MYSQL_PASSWORD",
  ),
  MYSQL_TABLE: getConfigValue(["output", "database", "table"], "MYSQL_TABLE"),
  MYSQL_DATABASE: getConfigValue(
    ["output", "database", "database"],
    "MYSQL_DATABASE",
  ),

  TELEGRAM_BOT_TOKEN: getConfigValue(
    ["output", "notifications", "telegram", "bot_token"],
    "TELEGRAM_BOT_TOKEN",
  ),
  TELEGRAM_CHAT_ID: getConfigValue(
    ["output", "notifications", "telegram", "chat_id"],
    "TELEGRAM_CHAT_ID",
  ),

  EMAIL_HOST: getConfigValue(
    ["output", "notifications", "email", "host"],
    "EMAIL_HOST",
  ),
  EMAIL_PORT: getConfigValue(
    ["output", "notifications", "email", "port"],
    "EMAIL_PORT",
  ),
  EMAIL_USER: getConfigValue(
    ["output", "notifications", "email", "username"],
    "EMAIL_USER",
  ),
  EMAIL_PASS: getConfigValue(
    ["output", "notifications", "email", "password"],
    "EMAIL_PASS",
  ),
  EMAIL_FROM: getConfigValue(
    ["output", "notifications", "email", "from"],
    "EMAIL_FROM",
  ),
  EMAIL_TO: getConfigValue(
    ["output", "notifications", "email", "to"],
    "EMAIL_TO",
  ),

  CSV_PATH: getConfigValue(
    ["output", "csv", "path"],
    "CSV_PATH",
    defaultCsvPath,
  ),
  DUCKDB_PATH: getConfigValue(
    ["output", "duckdb", "path"],
    "DUCKDB_PATH",
    defaultDuckdbPath,
  ),
  AIDS_DUCKDB_PATH: getConfigValue(
    ["processing", "deduplication", "aids_duckdb_path"],
    "AIDS_DUCKDB_PATH",
    defaultAidsDuckdbPath,
  ),
});
