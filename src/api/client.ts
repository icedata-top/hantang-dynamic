import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { config } from "../config";
import { StateManager } from "../core/state";
import { getRandomDelay, retryDelay, sleep } from "../utils/datetime";
import { logger } from "../utils/logger";
import { notify } from "../utils/notifier/notifier";
import { generateBiliTicket } from "./signatures/biliTicket";
import { buildSignedQuery } from "./signatures/wbiSignature";

interface RequestConfig extends InternalAxiosRequestConfig {
  metadata?: {
    startTime: number;
  };
}

export enum ApiErrorCode {
  Success = 0,
  CookieExpired = 4100000, // Cookie/authentication expired
  RiskControlFailed = -352, // 风控失败
}

export enum ApiErrorResponseCode {
  IpBanned = 416, // IP has been banned
}

const state = new StateManager();

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

export function createClient(baseURL: string): AxiosInstance {
  const stateManager = new StateManager();
  const ua = stateManager.lastUA;

  const client = axios.create({
    baseURL,
    headers: {
      "User-Agent": ua,
      Cookie: getCookieString(stateManager),
    },
  });

  client.interceptors.request.use(async (config) => {
    if (!stateManager.isTicketValid()) {
      logger.info("BiliTicket expired or not set, requesting a new one");
      const ticketData = await generateBiliTicket();
      if (ticketData) {
        stateManager.updateTicket(ticketData.ticket, ticketData.expiresAt);
        config.headers.Cookie = getCookieString(stateManager);
      }
    }
    return config;
  });

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const endTime = Date.now();
      const startTime =
        (response.config as RequestConfig).metadata?.startTime ?? 0;
      const timeUsed = endTime - startTime;
      const params = response.config.params
        ? ` params=${buildSignedQuery(response.config.params)}`
        : "";
      const data = response.config.data
        ? ` data=${JSON.stringify(response.config.data)}`
        : "";

      logger.debug(
        `[${new Date().toISOString()}] ${baseURL}${response.config.url}${params}${data} (${timeUsed}ms)`,
      );

      if (response.status == ApiErrorResponseCode.IpBanned) {
        logger.error(
          "CRITICAL ERROR: IP has been banned! Terminating process." +
            "致命错误：IP 被封禁！正在终止进程。",
        );
        process.exit(2);
      }

      // Handle non-success response codes
      if (response.data.code !== ApiErrorCode.Success) {
        const message =
          `API Error:\n` +
          `Code: ${response.data.code}\n` +
          `baseURL: ${baseURL + response.config.url}\n` +
          `Config: ${JSON.stringify(response.config)}\n` +
          `Response: ${JSON.stringify(response.data || "No message")?.slice(0, 1000)}`;
        notify(message);

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

      return response;
    },
    async (error) => {
      if (!error.response) {
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

function getCookieString(stateManager: StateManager): string {
  let cookie = `SESSDATA=${config.bilibili.sessdata}`;

  if (config.bilibili.csrfToken) {
    cookie += `; bili_jct=${config.bilibili.csrfToken}`;
  }

  if (stateManager.biliTicket) {
    cookie += `; bili_ticket=${stateManager.biliTicket}`;
  }

  return cookie;
}

export const dynamicClient = createClient(
  "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
);
export const xClient = createClient("https://api.bilibili.com/x");
export const accountClient = createClient("https://account.bilibili.com/api");
