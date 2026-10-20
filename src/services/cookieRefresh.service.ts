import { constants, publicEncrypt } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { RequestConfig } from "../api/client";
import type { AccountContext } from "../core/account";
import { getCookieValue } from "../utils/cookieFile";
import { logger } from "../utils/logger";

const REFRESH_TOKEN_SUFFIX = ".refresh_token";
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
  code?: number;
  message?: string;
  data?: { refresh?: boolean; timestamp?: number; refresh_token?: string };
};
function tokenPath(cookieFilePath: string): string {
  return `${cookieFilePath}${REFRESH_TOKEN_SUFFIX}`;
}

function readToken(cookieFilePath: string): string | null {
  const path = tokenPath(cookieFilePath);
  return existsSync(path) ? readFileSync(path, "utf-8").trim() || null : null;
}

function writeToken(cookieFilePath: string, token: string): void {
  const staged = `${tokenPath(cookieFilePath)}.tmp`;
  writeFileSync(staged, `${token}\n`, { mode: 0o600 });
  chmodSync(staged, 0o600);
  renameSync(staged, tokenPath(cookieFilePath));
}

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
  const token = readToken(file);
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
  if (nextToken) writeToken(file, nextToken);
  else logger.warn(`[uid=${account.uid}] refresh returned no refresh_token`);

  const nextCsrf = getCookieValue(jar, "bili_jct");
  if (!nextCsrf) throw new Error("refreshed cookies are missing bili_jct");
  await client.post(
    CONFIRM_URL,
    new URLSearchParams({ csrf: nextCsrf, refresh_token: token }),
  );
  logger.info(`[uid=${account.uid}] Bilibili cookies refreshed`);
}

/**
 * Refreshes cookies when `<cookie file>.refresh_token` exists. The sidecar holds
 * the browser's `ac_time_value` and is replaced after each rotation.
 */
export class CookieRefreshService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly accounts: AccountContext[]) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refreshAll(): Promise<void> {
    for (const account of this.accounts) {
      if (!this.running) return;
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
}
