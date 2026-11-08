import { constants, publicEncrypt } from "node:crypto";
import type { RequestConfig } from "../api/client";
import type { AccountContext } from "../core/account";
import { getCookieValue, writeCookieJarToNetscape } from "../utils/cookieFile";
import { logger } from "../utils/logger";
import { readRefreshToken, writeRefreshToken } from "../utils/refreshTokenFile";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INFO_URL =
  "https://passport.bilibili.com/x/passport-login/web/cookie/info";
const REFRESH_URL =
  "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
const CONFIRM_URL =
  "https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
const CORRESPOND_URL = "https://www.bilibili.com/correspond/1";
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

type ApiPayload = {
  data?: { refresh?: boolean; timestamp?: number; refresh_token?: string };
};
/** RSA-OAEP(SHA-256) of `refresh_<timestamp>`; this is the correspond path. */
export function buildCorrespondPath(timestamp = Date.now()): string {
  return publicEncrypt(
    {
      key: PUBLIC_KEY,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(`refresh_${timestamp}`),
  ).toString("hex");
}

export function extractRefreshCsrf(html: string): string | null {
  return (
    /<div id=["']1-name["']>([^<]+)<\/div>/.exec(html)?.[1]?.trim() || null
  );
}

async function refreshAccount(account: AccountContext): Promise<void> {
  const { cookieJar: jar, cookieFilePath: file } = account;
  if (!jar || !file) return;
  const token = readRefreshToken(file);
  if (!token) return;

  const csrf = getCookieValue(jar, "bili_jct");
  if (!csrf) throw new Error("cookie refresh requires bili_jct");

  const client = account.webInterfaceClient;
  const info = await client.get(INFO_URL, { params: { csrf } });
  const infoData = (info.data as ApiPayload).data;
  if (infoData?.refresh !== true) return;

  const timestamp =
    typeof infoData.timestamp === "number" && infoData.timestamp > 0
      ? infoData.timestamp
      : Date.now();
  const correspond = await client.get(
    `${CORRESPOND_URL}/${buildCorrespondPath(timestamp)}`,
    {
      responseType: "text",
      headers: { Accept: "text/html" },
      maxRedirects: 0,
      metadata: { skipApiChecks: true },
    } as RequestConfig,
  );
  const refreshCsrf = extractRefreshCsrf(String(correspond.data));
  if (!refreshCsrf) throw new Error("correspond page has no refresh_csrf");

  const refreshed = await client.post(
    REFRESH_URL,
    new URLSearchParams({
      csrf,
      refresh_csrf: refreshCsrf,
      refresh_token: token,
      source: "main_web",
    }),
  );
  const nextToken = (refreshed.data as ApiPayload).data?.refresh_token;
  if (!writeCookieJarToNetscape(jar, file)) return;
  if (nextToken) writeRefreshToken(file, nextToken);
  else logger.warn(`[uid=${account.uid}] refresh returned no refresh_token`);

  const nextCsrf = getCookieValue(jar, "bili_jct");
  if (!nextCsrf) throw new Error("refreshed cookies are missing bili_jct");
  await client.post(
    CONFIRM_URL,
    new URLSearchParams({ csrf: nextCsrf, refresh_token: token }),
  );
  logger.info(`[uid=${account.uid}] Bilibili cookies refreshed`);
}

async function refreshAll(accounts: AccountContext[]): Promise<void> {
  for (const account of accounts) {
    try {
      await refreshAccount(account);
    } catch (error) {
      logger.warn(
        `[uid=${account.uid}] Bilibili cookie refresh failed:`,
        error,
      );
    }
  }
}

/**
 * Refreshes cookies when `<cookie file>.refresh_token` exists, then checks every
 * six hours. Returns a stop function for graceful shutdown.
 */
export async function startCookieRefresh(
  accounts: AccountContext[],
): Promise<() => void> {
  await refreshAll(accounts);
  const timer = setInterval(() => void refreshAll(accounts), CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
