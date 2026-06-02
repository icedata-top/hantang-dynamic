import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { wrapper } from "axios-cookiejar-support";
import type { CookieJar } from "tough-cookie";
import { config } from "../config";
import { StateManager } from "../core/state";
import {
  createCookieJarFromNetscape,
  getAllCookiesAsString,
  parseNetscapeCookieFile,
  writeCookieJarToNetscape,
} from "../utils/cookieFile";
import { getRandomDelay, retryDelay, sleep } from "../utils/datetime";
import { logger } from "../utils/logger";
import { notifyWarning } from "../utils/notifier/notifier";
import { redactSensitive } from "../utils/redact";
import { generateBiliTicket } from "./signatures/biliTicket";
import { buildSignedQuery } from "./signatures/wbiSignature";

export interface RequestConfig extends InternalAxiosRequestConfig {
  metadata?: {
    startTime: number;
    silent?: boolean;
  };
}

enum ApiErrorCode {
  Success = 0,
  CookieExpired = 4100000, // Cookie/authentication expired
  RiskControlFailed = -352, // 风控失败
}

enum ApiErrorResponseCode {
  IpBanned = 416, // IP has been banned
}

const state = new StateManager();

// Singleton cookie jar manager for cookie file support
let globalCookieJar: CookieJar | null = null;
let cookieFilePath: string | null = null;

function getGlobalCookieJar(): CookieJar | null {
  if (!config.bilibili.cookieFile) return null;
  if (!globalCookieJar) {
    const cookies = parseNetscapeCookieFile(config.bilibili.cookieFile);
    globalCookieJar = createCookieJarFromNetscape(cookies);
    cookieFilePath = config.bilibili.cookieFile;
  }
  return globalCookieJar;
}

/**
 * Simulate a browser visit to a specific page with appropriate referrer
 * @param url The URL to visit
 * @param referrer The referrer to set in headers
 */
export const simulateBrowserVisit = async (
  url: string,
  referrer?: string,
): Promise<void> => {
  try {
    await sleep(getRandomDelay(500, 1000));

    await axios.get(url, {
      headers: {
        "User-Agent": state.lastUA,
        Referer: referrer || "https://www.bilibili.com/",
      },
    });

    logger.debug(`Simulated visit to ${url}`);
  } catch (error) {
    logger.warn(`Failed to simulate visit to ${url}: ${error}`);
  }
};

interface CreateClientOptions {
  skipCookie?: boolean;
  /** Explicit cookie jar (overrides global jar; for per-account clients) */
  cookieJar?: CookieJar;
  /** Path to persist the explicit jar to (required when cookieJar is provided) */
  cookieFilePath?: string;
  /** State manager to use for ticket renewal (defaults to shared global StateManager) */
  stateManager?: StateManager;
}

type CookieJarAxiosDefaults = AxiosInstance["defaults"] & {
  jar?: CookieJar;
};

function createClient(
  baseURL: string,
  optionsOrSkip?: boolean | CreateClientOptions,
): AxiosInstance {
  const options: CreateClientOptions =
    typeof optionsOrSkip === "boolean"
      ? { skipCookie: optionsOrSkip }
      : (optionsOrSkip ?? {});

  const skipCookie = options.skipCookie ?? false;
  const resolvedStateManager = options.stateManager ?? new StateManager();
  const ua = resolvedStateManager.lastUA;

  // Determine which jar to use: explicit > global > none
  const jar =
    options.cookieJar !== undefined
      ? options.cookieJar
      : skipCookie
        ? null
        : getGlobalCookieJar();

  // Determine which file to persist the jar to
  const resolvedFilePath =
    options.cookieFilePath !== undefined
      ? options.cookieFilePath
      : cookieFilePath;

  const persistJar = () => {
    if (jar && resolvedFilePath) {
      writeCookieJarToNetscape(jar, resolvedFilePath);
    }
  };

  // If cookie jar is available, use axios-cookiejar-support
  const axiosInstance = jar ? wrapper(axios.create()) : axios.create();
  const client = axiosInstance;

  client.defaults.baseURL = baseURL;
  client.defaults.headers.common["User-Agent"] = ua;

  if (jar) {
    // Use tough-cookie jar for cookie management
    (client.defaults as CookieJarAxiosDefaults).jar = jar;
    client.defaults.withCredentials = true;
  } else if (!skipCookie) {
    // Fall back to manual cookie string from config
    client.defaults.headers.common.Cookie = getCookieString(
      resolvedStateManager,
      null,
    );
  }

  client.interceptors.request.use(async (reqConfig) => {
    // Set start time for performance tracking
    const existingMetadata = (reqConfig as RequestConfig).metadata || {};
    (reqConfig as RequestConfig).metadata = {
      ...existingMetadata,
      startTime: Date.now(),
    };

    if (!skipCookie && !resolvedStateManager.isTicketValid()) {
      logger.info("BiliTicket expired or not set, requesting a new one");
      const ticketData = await generateBiliTicket();
      if (ticketData) {
        resolvedStateManager.updateTicket(
          ticketData.ticket,
          ticketData.expiresAt,
        );
        if (!skipCookie) {
          reqConfig.headers.Cookie = getCookieString(resolvedStateManager, jar);
        }
      }
    }
    return reqConfig;
  });

  client.interceptors.response.use(
    async (response: AxiosResponse) => {
      const endTime = Date.now();
      const startTime =
        (response.config as RequestConfig).metadata?.startTime ?? 0;
      const timeUsed = endTime - startTime;
      const params = response.config.params
        ? ` params=${await buildSignedQuery(response.config.params).catch(
            () => "failed_to_sign",
          )}`
        : "";
      const data = response.config.data
        ? ` data=${JSON.stringify(response.config.data)}`
        : "";

      logger.debug(
        `[${new Date().toISOString()}] ${baseURL}${response.config.url}${params}${data} (${timeUsed}ms)`,
      );

      if (response.status === ApiErrorResponseCode.IpBanned) {
        const message =
          "CRITICAL ERROR: IP has been banned! Terminating process.";
        logger.error(`${message}致命错误：IP·被封禁！正在终止进程。`);
        await notifyWarning(message);
        process.exit(2);
      }

      // Handle non-success response codes
      if (
        response.data.code !== ApiErrorCode.Success &&
        response.data.code !== 404 &&
        response.data.code !== -404 &&
        response.data.code !== 62012 &&
        response.data.code !== 62002 &&
        response.data.code !== 62004
      ) {
        const message =
          `API Error:\n` +
          `Code: ${response.data.code}\n` +
          `baseURL: ${baseURL + response.config.url}\n` +
          `Config: ${JSON.stringify(redactSensitive(response.config))}\n` +
          `Response: ${JSON.stringify(response.data || "No message")?.slice(
            0,
            1000,
          )}`;

        // We must await notify before exiting, otherwise the message might not be sent
        if (!(response.config as RequestConfig).metadata?.silent) {
          await notifyWarning(message);
        }

        if (response.data.code === ApiErrorCode.CookieExpired) {
          logger.error(
            "CRITICAL ERROR: Cookie has expired! Authentication required. Terminating process.\n" +
              "致命错误：Cookie 已过期！请重新登录。正在终止进程。",
          );
          process.exit(1);
        }

        if (response.data.code === ApiErrorCode.RiskControlFailed) {
          logger.error(
            "CRITICAL ERROR: Risk control failed! Terminating process.\n" +
              "致命错误：风控失败！正在终止进程。",
          );
          process.exit(3);
        }

        return Promise.reject(
          new Error(`API Error: code ${response.data.code}`),
        );
      }

      // Persist cookies if Set-Cookie header is present and using cookie jar
      const setCookieHeader = response.headers["set-cookie"];
      if (setCookieHeader && jar) {
        persistJar();
      }

      return response;
    },
    async (error) => {
      if (!error.response || error.response.status === 524) {
        return retryDelay(
          () => client(error.config),
          config.application.apiRetryTimes,
          config.application.apiWaitTime,
        );
      }
      return Promise.reject({
        message: error.message,
        code: error.response?.status,
        data: error.response?.data,
      });
    },
  );

  return client;
}

function getCookieString(
  stateManager: StateManager,
  jar?: CookieJar | null,
): string {
  const resolvedJar = jar !== undefined ? jar : getGlobalCookieJar();

  // If using cookie jar, use the full cookie string from the jar
  if (resolvedJar) {
    let cookie = getAllCookiesAsString(resolvedJar);
    if (stateManager.biliTicket) {
      cookie += `; bili_ticket=${stateManager.biliTicket}`;
    }
    return cookie;
  }

  // Fall back to config values (existing behavior)
  let cookie = `SESSDATA=${config.bilibili.sessdata || ""}`;

  if (config.bilibili.csrfToken) {
    cookie += `; bili_jct=${config.bilibili.csrfToken}`;
  }

  if (stateManager.biliTicket) {
    cookie += `; bili_ticket=${stateManager.biliTicket}`;
  }

  return cookie;
}

/**
 * Create a dynamic API client for a specific account (cookie jar + state).
 * Used by AccountContext to give each cookie file its own authenticated client.
 */
export function createAccountDynamicClient(
  baseURL: string,
  cookieJar: CookieJar,
  accountCookieFilePath: string,
  stateManager: StateManager,
): AxiosInstance {
  return createClient(baseURL, {
    cookieJar,
    cookieFilePath: accountCookieFilePath,
    stateManager,
  });
}

export const dynamicClient = createClient(
  "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
);

export const dynamicDetailClient = createClient(
  config.bilibili.dynamicProxyUrl
    ? `${config.bilibili.dynamicProxyUrl}/dynamic_svr/v1/dynamic_svr`
    : "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
  !!config.bilibili.dynamicProxyUrl,
);

export const webInterfaceClient = createClient(
  config.bilibili.apiProxyUrl
    ? `${config.bilibili.apiProxyUrl}/x/web-interface`
    : "https://api.bilibili.com/x/web-interface",
  !!config.bilibili.apiProxyUrl,
);

// Direct client without proxy for fallback
export const webInterfaceDirectClient = createClient(
  "https://api.bilibili.com/x/web-interface",
);

export const medialistClient = createClient(
  config.bilibili.apiProxyUrl
    ? `${config.bilibili.apiProxyUrl}/medialist`
    : "https://api.bilibili.com/medialist",
  !!config.bilibili.apiProxyUrl,
);

export const medialistDirectClient = createClient(
  "https://api.bilibili.com/medialist",
);

export const relationClient = createClient(
  "https://api.bilibili.com/x/relation",
);

export const accountClient = createClient("https://account.bilibili.com/api");
