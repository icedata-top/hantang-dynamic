import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  applicationSchema,
  bilibiliSchema,
  exportSchema,
  notificationsSchema,
  processingSchema,
} from "./schemas";

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

const configSchema = z.object({
  bilibili: bilibiliSchema,
  application: applicationSchema,
  processing: processingSchema,
  export: exportSchema,
  notifications: notificationsSchema,
});

// Generate default paths based on UID
const bilibiliUid = getConfigValue(["bilibili", "uid"], "BILIBILI_UID");
const defaultCsvPath = bilibiliUid
  ? `./data/uid${bilibiliUid}.csv`
  : "./data/uid.csv";
const defaultDuckdbPath = bilibiliUid
  ? `./data/uid${bilibiliUid}.duckdb`
  : "./data/uid.duckdb";
const defaultAidsDuckdbPath = "./data/aids.duckdb";

export const config = configSchema.parse({
  bilibili: {
    uid: getConfigValue(["bilibili", "uid"], "BILIBILI_UID"),
    sessdata: getConfigValue(["bilibili", "sessdata"], "SESSDATA"),
    csrfToken: getConfigValue(["bilibili", "csrf_token"], "BILI_JCT"),
    accessKey: getConfigValue(["bilibili", "access_key"], "BILI_ACCESS_KEY"),
  },
  application: {
    logLevel: getConfigValue(["application", "log_level"], "LOGLEVEL", "info"),
    fetchInterval: getConfigValue(
      ["application", "fetch_interval"],
      "FETCH_INTERVAL",
      900_000,
    ),
    apiRetryTimes: getConfigValue(
      ["application", "api_retry_times"],
      "API_RETRY_TIMES",
      3,
    ),
    apiWaitTime: getConfigValue(
      ["application", "api_wait_time"],
      "API_WAIT_TIME",
      2000,
    ),
    maxHistoryDays: getConfigValue(
      ["application", "max_history_days"],
      "MAX_HISTORY_DAYS",
      7,
    ),
    maxItem: getConfigValue(["application", "max_item"], "MAX_ITEM", 0),
  },
  processing: {
    features: {
      enableTagFetch: getConfigValue(
        ["processing", "features", "enable_tag_fetch"],
        "ENABLE_TAG_FETCH",
        false,
      ),
      enableUserRelation: getConfigValue(
        ["processing", "features", "enable_user_relation"],
        "ENABLE_USER_RELATION",
        false,
      ),
    },
    filtering: {
      typeIdWhitelist:
        getConfigValue(
          ["processing", "filtering", "type_id_whitelist"],
          "TYPE_ID_WHITE_LIST",
        ) ||
        process.env.TYPE_ID_WHITE_LIST?.split(",").map(Number) ||
        [],
      contentBlacklist:
        getConfigValue(
          ["processing", "filtering", "content_blacklist"],
          "CONTENT_BLACK_LIST",
        ) ||
        process.env.CONTENT_BLACK_LIST?.split(",").map((s) => s.trim()) ||
        [],
      contentWhitelist:
        getConfigValue(
          ["processing", "filtering", "content_whitelist"],
          "CONTENT_WHITE_LIST",
        ) ||
        process.env.CONTENT_WHITE_LIST?.split(",").map((s) => s.trim()) ||
        [],
    },
    deduplication: {
      aidsDuckdbPath: getConfigValue(
        ["processing", "deduplication", "aids_duckdb_path"],
        "AIDS_DUCKDB_PATH",
        defaultAidsDuckdbPath,
      ),
    },
  },
  export: {
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
  },
  notifications: {
    email: {
      host: getConfigValue(["notifications", "email", "host"], "EMAIL_HOST"),
      port: getConfigValue(["notifications", "email", "port"], "EMAIL_PORT"),
      username: getConfigValue(
        ["notifications", "email", "username"],
        "EMAIL_USER",
      ),
      password: getConfigValue(
        ["notifications", "email", "password"],
        "EMAIL_PASS",
      ),
      from: getConfigValue(["notifications", "email", "from"], "EMAIL_FROM"),
      to: getConfigValue(["notifications", "email", "to"], "EMAIL_TO"),
    },
    telegram: {
      botToken: getConfigValue(
        ["notifications", "telegram", "bot_token"],
        "TELEGRAM_BOT_TOKEN",
      ),
      chatId: getConfigValue(
        ["notifications", "telegram", "chat_id"],
        "TELEGRAM_CHAT_ID",
      ),
    },
  },
});

export type Config = z.infer<typeof configSchema>;

// Re-export all types and schemas for convenience
export * from "./schemas";
