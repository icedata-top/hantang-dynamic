import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { appSchema } from "./app";
import { bilibiliSchema } from "./bilibili";
import { outputsSchema } from "./outputs";

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
  app: appSchema,
  bilibili: bilibiliSchema,
  outputs: outputsSchema,
});

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

export const config = configSchema.parse({
  app: {
    logLevel: getConfigValue(
      ["input", "application", "log_level"],
      "LOGLEVEL",
      "info",
    ),
    fetchInterval: getConfigValue(
      ["input", "application", "fetch_interval"],
      "FETCH_INTERVAL",
      900_000,
    ),
    apiRetry: {
      times: getConfigValue(
        ["input", "application", "api_retry_times"],
        "API_RETRY_TIMES",
        3,
      ),
      waitTime: getConfigValue(
        ["input", "application", "api_wait_time"],
        "API_WAIT_TIME",
        2000,
      ),
    },
    maxHistoryDays: getConfigValue(
      ["input", "application", "max_history_days"],
      "MAX_HISTORY_DAYS",
      7,
    ),
    maxItem: getConfigValue(
      ["input", "application", "max_item"],
      "MAX_ITEM",
      0,
    ),
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
  bilibili: {
    uid: getConfigValue(["input", "bilibili", "uid"], "BILIBILI_UID"),
    sessdata: getConfigValue(["input", "bilibili", "sessdata"], "SESSDATA"),
    csrfToken: getConfigValue(["input", "bilibili", "csrf_token"], "BILI_JCT"),
    accessKey: getConfigValue(
      ["input", "bilibili", "access_key"],
      "BILI_ACCESS_KEY",
    ),
  },
  outputs: {
    database: {
      mysql: {
        host: getConfigValue(["output", "database", "host"], "MYSQL_IP"),
        port: getConfigValue(["output", "database", "port"], "MYSQL_PORT"),
        username: getConfigValue(
          ["output", "database", "username"],
          "MYSQL_USERNAME",
        ),
        password: getConfigValue(
          ["output", "database", "password"],
          "MYSQL_PASSWORD",
        ),
        table: getConfigValue(["output", "database", "table"], "MYSQL_TABLE"),
        database: getConfigValue(
          ["output", "database", "database"],
          "MYSQL_DATABASE",
        ),
      },
      csv: {
        path: getConfigValue(
          ["output", "csv", "path"],
          "CSV_PATH",
          defaultCsvPath,
        ),
      },
      duckdb: {
        path: getConfigValue(
          ["output", "duckdb", "path"],
          "DUCKDB_PATH",
          defaultDuckdbPath,
        ),
      },
    },
    notification: {
      email: {
        host: getConfigValue(
          ["output", "notifications", "email", "host"],
          "EMAIL_HOST",
        ),
        port: getConfigValue(
          ["output", "notifications", "email", "port"],
          "EMAIL_PORT",
        ),
        user: getConfigValue(
          ["output", "notifications", "email", "username"],
          "EMAIL_USER",
        ),
        pass: getConfigValue(
          ["output", "notifications", "email", "password"],
          "EMAIL_PASS",
        ),
        from: getConfigValue(
          ["output", "notifications", "email", "from"],
          "EMAIL_FROM",
        ),
        to: getConfigValue(
          ["output", "notifications", "email", "to"],
          "EMAIL_TO",
        ),
      },
      telegram: {
        botToken: getConfigValue(
          ["output", "notifications", "telegram", "bot_token"],
          "TELEGRAM_BOT_TOKEN",
        ),
        chatId: getConfigValue(
          ["output", "notifications", "telegram", "chat_id"],
          "TELEGRAM_CHAT_ID",
        ),
      },
    },
  },
});

export type Config = z.infer<typeof configSchema>;
