import axios, { InternalAxiosRequestConfig, AxiosResponse } from "axios";
import { config } from "../core/config";
import { sleep, getRandomDelay, retryDelay } from "../utils/datetime";
import { notify } from "../utils/notifier/notifier";
import { StateManager } from "../core/state";
import { logger } from "../utils/logger";

interface RequestConfig extends InternalAxiosRequestConfig {
  metadata?: {
    startTime: number;
  };
}

const state = new StateManager();

/**
 * Simulate a browser visit to a specific page with appropriate referrer
 * @param url The URL to visit
 * @param referrer The referrer to set in headers
 */
export const simulateBrowserVisit = async (url: string, referrer?: string): Promise<void> => {
  try {
    await sleep(getRandomDelay(500, 1000));
    
    await axios.get(url, {
      headers: {
        'User-Agent': state.lastUA,
        'Referer': referrer || 'https://www.bilibili.com/'
      }
    });
    
    logger.debug(`Simulated visit to ${url}`);
  } catch (error) {
    logger.warn(`Failed to simulate visit to ${url}: ${error}`);
  }
};

const createClient = (baseURL: string) => {
  const instance = axios.create({
    baseURL,
    headers: {
      Referer: `https://space.bilibili.com/${config.BILIBILI_UID}/`,
      Cookie: `SESSDATA=${config.SESSDATA}`,
      "User-Agent": state.lastUA,
    },
  });

  instance.interceptors.request.use((config: RequestConfig) => {
    config.metadata = { startTime: Date.now() };
    return config;
  });
  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      const endTime = Date.now();
      const startTime =
        (response.config as RequestConfig).metadata?.startTime ?? 0;
      const timeUsed = endTime - startTime;
      const params = response.config.params
        ? ` params=${JSON.stringify(response.config.params)}`
        : "";
      const data = response.config.data
        ? ` data=${JSON.stringify(response.config.data)}`
        : "";

      logger.debug(
        `[${new Date().toISOString()}] ${baseURL}${response.config.url}${params}${data} (${timeUsed}ms)`,
      );
      if (response.data.code !== 0) {
        const message =
          `API Error:\n` +
          `baseURL: ${baseURL + response.config.url}\n` +
          `Config: ${JSON.stringify(response.config)}\n` +
          `Response: ${JSON.stringify(response.data || "No message")?.slice(0, 1000)}`;
        notify(message);
        return Promise.reject(new Error(`API Error: ${response.data.msg}`));
      }
      return response;
    },
    async (error) => {
      if (!error.response) {
        return retryDelay(
          () => instance(error.config),
          config.API_RETRY_TIMES,
          config.API_WAIT_TIME,
        );
      }
      return Promise.reject({
        message: error.message,
        code: error.response?.status,
        data: error.response?.data,
      });
    },
  );

  return instance;
};

export const dynamicClient = createClient(
  "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
);
export const xClient = createClient("https://api.bilibili.com/x");
export const accountClient = createClient("https://account.bilibili.com/api");