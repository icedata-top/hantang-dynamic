import { z } from "zod";

// Base schema without refinement for inference
const bilibiliBaseSchema = z.object({
  uid: z.string().optional(), // Optional when cookie_file/cookie_files is used (uid extracted from DedeUserID)
  sessdata: z.string().optional(), // Optional when cookieFile is used
  csrfToken: z.string().optional(),
  accessKey: z.string().optional(),
  apiProxyUrl: z.string().optional(),
  dynamicProxyUrl: z.string().optional(),
  cookieFile: z.string().optional(), // First cookie file path (backward compat alias for cookieFiles[0])
  cookieFiles: z.array(z.string()).default([]), // All cookie file paths (canonical)
});

// Bilibili authentication and API configuration
export const bilibiliSchema = bilibiliBaseSchema
  .refine((data) => data.cookieFiles.length > 0 || !!data.sessdata, {
    message: "Either cookie_file, cookie_files, or sessdata must be provided",
  })
  .refine(
    (data) => {
      // uid is required when using sessdata without any cookie file
      if (data.cookieFiles.length === 0 && data.sessdata) {
        return !!data.uid;
      }
      return true;
    },
    { message: "uid is required when using sessdata (without a cookie file)" },
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
  // Support both single cookie_file and array cookie_files
  const multipleCookieFilesRaw = getConfigValue(
    ["bilibili", "cookie_files"],
    "BILIBILI_COOKIE_FILES",
  );

  let cookieFiles: string[] = [];
  if (Array.isArray(multipleCookieFilesRaw)) {
    // From TOML: native array
    cookieFiles = multipleCookieFilesRaw.filter(Boolean);
  } else if (
    typeof multipleCookieFilesRaw === "string" &&
    multipleCookieFilesRaw
  ) {
    // From env var: comma-separated list
    cookieFiles = multipleCookieFilesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    // Fallback to single cookie_file
    const singleCookieFile = getConfigValue(
      ["bilibili", "cookie_file"],
      "BILIBILI_COOKIE_FILE",
    );
    if (singleCookieFile) {
      cookieFiles = [singleCookieFile];
    }
  }

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
    cookieFile: cookieFiles[0] || undefined,
    cookieFiles,
  };
}
