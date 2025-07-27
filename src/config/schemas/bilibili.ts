import { z } from "zod";

// Bilibili authentication and API configuration
export const bilibiliSchema = z.object({
  uid: z.string(),
  sessdata: z.string(),
  csrfToken: z.string().optional(),
  accessKey: z.string().optional(),
  apiProxyUrl: z.string().optional(),
});

export type BilibiliConfig = z.infer<typeof bilibiliSchema>;

export function createBilibiliConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): BilibiliConfig {
  return {
    uid: getConfigValue(["bilibili", "uid"], "BILIBILI_UID"),
    sessdata: getConfigValue(["bilibili", "sessdata"], "SESSDATA"),
    csrfToken: getConfigValue(["bilibili", "csrf_token"], "BILI_JCT"),
    accessKey: getConfigValue(["bilibili", "access_key"], "BILI_ACCESS_KEY"),
    apiProxyUrl: getConfigValue(["bilibili", "api_proxy_url"], "BILIBILI_API_PROXY_URL"),
  };
}
