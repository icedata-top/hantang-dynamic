import axios from "axios";
import { config } from "../core/config";
import { retryDelay } from "../utils/datetime";
import { notify } from "../utils/notifier";

const createClient = (baseURL: string) => {
  const instance = axios.create({
    baseURL,
    headers: {
      Referer: `https://space.bilibili.com/${config.BILIBILI_UID}/`,
      Cookie: `SESSDATA=${config.SESSDATA}`,
    },
  });

  instance.interceptors.response.use(
    (response) => {
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
export const videoClient = createClient("https://api.bilibili.com/x");
