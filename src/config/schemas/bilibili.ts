import { z } from "zod";

// Base schema without refinement for inference
const bilibiliBaseSchema = z.object({
  uid: z.string(),
  sessdata: z.string().optional(), // Optional when cookieFile is used
  csrfToken: z.string().optional(),
  accessKey: z.string().optional(),
  apiProxyUrl: z.string().optional(),
  dynamicProxyUrl: z.string().optional(),
  cookieFile: z.string().optional(), // Path to Netscape cookie file
});

// Bilibili authentication and API configuration
export const bilibiliSchema = bilibiliBaseSchema.refine(
  (data) => data.cookieFile || data.sessdata,
  { message: "Either cookieFile or sessdata must be provided" },
);

export type BilibiliConfig = z.infer<typeof bilibiliBaseSchema>;

export function createBilibiliConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): BilibiliConfig {
  return {
    uid: getConfigValue(["bilibili", "uid"], "BILIBILI_UID"),
    sessdata: getConfigValue(["bilibili", "sessdata"], "SESSDATA"),
    csrfToken: getConfigValue(["bilibili", "csrf_token"], "BILI_JCT"),
    accessKey: getConfigValue(["bilibili", "access_key"], "BILI_ACCESS_KEY"),
    apiProxyUrl: getConfigValue(
      ["bilibili", "api_proxy_url"],
      "BILIBILI_API_PROXY_URL",
    ),
    dynamicProxyUrl: getConfigValue(
      ["bilibili", "dynamic_proxy_url"],
      "BILIBILI_DYNAMIC_PROXY_URL",
    ),
    cookieFile: getConfigValue(
      ["bilibili", "cookie_file"],
      "BILIBILI_COOKIE_FILE",
    ),
  };
}
