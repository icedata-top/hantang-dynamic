import { constants, publicEncrypt, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import axios, { type AxiosResponse } from "axios";
import type { CookieJar } from "tough-cookie";
import type { AccountContext } from "../core/account";
import {
  keepAuthCookiesAsSession,
  writeCookieJarToNetscape,
} from "../utils/cookieFile";
import { logger } from "../utils/logger";

const REFRESH_TOKEN_SUFFIX = ".refresh_token";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const COOKIE_INFO_URL =
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

const http = axios.create({
  timeout: 30_000,
  maxRedirects: 0,
  validateStatus: () => true,
});

interface ApiPayload {
  code?: number;
  message?: string;
  data?: { refresh?: boolean; refresh_token?: string };
}

function refreshTokenPath(cookieFilePath: string): string {
  return `${cookieFilePath}${REFRESH_TOKEN_SUFFIX}`;
}

function readRefreshToken(cookieFilePath: string): string | null {
  const path = refreshTokenPath(cookieFilePath);
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf-8").trim();
  return token || null;
}

function writeRefreshToken(cookieFilePath: string, token: string): void {
  const path = refreshTokenPath(cookieFilePath);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${token}\n`, { mode: 0o600 });
  chmodSync(staged, 0o600);
  renameSync(staged, path);
}

/** RSA-OAEP(SHA-256) of `refresh_<timestamp>`; this is the correspond path. */
export function buildCorrespondPath(now = Date.now()): string {
  const encrypted = publicEncrypt(
    {
      key: PUBLIC_KEY,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(`refresh_${now}`),
  );
  return encrypted.toString("hex");
}

export function extractRefreshCsrf(html: string): string | null {
  const match = /<div id=["']1-name["']>([^<]+)<\/div>/.exec(html);
  return match?.[1]?.trim() || null;
}

function cookieHeader(account: AccountContext, randomBuvid3: boolean): string {
  const jar = account.cookieJar;
  if (!jar) return "";
  const cookies = jar
    .getCookiesSync("https://www.bilibili.com/", { allPaths: true })
    .filter((cookie) => !(randomBuvid3 && cookie.key === "buvid3"))
    .map((cookie) => `${cookie.key}=${cookie.value}`);
  if (randomBuvid3) cookies.push(`buvid3=${randomUUID()}`);
  return cookies.join("; ");
}

function cookieValue(jar: CookieJar, name: string): string | null {
  return (
    jar
      .getCookiesSync("https://www.bilibili.com/", { allPaths: true })
      .find((cookie) => cookie.key === name)?.value ?? null
  );
}

function applySetCookie(
  jar: CookieJar,
  response: AxiosResponse,
  url: string,
): void {
  const raw = response.headers["set-cookie"] as unknown;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : [];
  for (const value of values) {
    try {
      jar.setCookieSync(value, url);
    } catch (error) {
      logger.warn(
        `Failed to apply cookie from ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function headers(
  account: AccountContext,
  cookie: string,
  contentType?: string,
): Record<string, string> {
  return {
    "User-Agent": account.stateManager.lastUA,
    Referer: "https://www.bilibili.com",
    Cookie: cookie,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function payloadCode(response: AxiosResponse): number | undefined {
  const data = response.data as ApiPayload | undefined;
  return typeof data?.code === "number" ? data.code : undefined;
}

function payloadMessage(response: AxiosResponse): string {
  const data = response.data as ApiPayload | undefined;
  return typeof data?.message === "string" ? data.message : "";
}

function failure(response: AxiosResponse, operation: string): Error {
  return new Error(
    `${operation} failed: HTTP ${response.status}, code ${String(
      payloadCode(response),
    )} ${payloadMessage(response)}`,
  );
}

async function fetchRefreshCsrf(
  account: AccountContext,
  jar: CookieJar,
): Promise<string> {
  const url = `${CORRESPOND_URL}/${buildCorrespondPath()}`;
  const response = await http.get(url, {
    headers: {
      ...headers(account, cookieHeader(account, true)),
      Accept: "text/html",
    },
    responseType: "text",
  });
  applySetCookie(jar, response, url);
  if (response.status !== 200) throw failure(response, "correspond");
  const csrf = extractRefreshCsrf(String(response.data));
  if (!csrf) throw new Error("correspond page did not contain refresh_csrf");
  return csrf;
}

async function refreshAccount(account: AccountContext): Promise<boolean> {
  const file = account.cookieFilePath;
  const jar = account.cookieJar;
  if (!file || !jar) return false;

  const refreshToken = readRefreshToken(file);
  if (!refreshToken) return false;

  const info = await http.get(COOKIE_INFO_URL, {
    headers: headers(account, cookieHeader(account, false)),
  });
  applySetCookie(jar, info, COOKIE_INFO_URL);
  if (info.status !== 200 || payloadCode(info) !== 0) {
    throw failure(info, "cookie/info");
  }
  const refreshDue = (info.data as ApiPayload | undefined)?.data?.refresh;
  if (refreshDue !== true) {
    logger.debug(`[uid=${account.uid}] Bilibili cookies do not need refresh`);
    return false;
  }

  const csrf = cookieValue(jar, "bili_jct");
  if (!csrf) throw new Error("cookie refresh requires bili_jct");

  const refreshCsrf = await fetchRefreshCsrf(account, jar);
  const response = await http.post(
    REFRESH_URL,
    new URLSearchParams({
      csrf,
      refresh_csrf: refreshCsrf,
      refresh_token: refreshToken,
      source: "main_web",
    }),
    {
      headers: headers(
        account,
        cookieHeader(account, true),
        "application/x-www-form-urlencoded",
      ),
    },
  );
  applySetCookie(jar, response, REFRESH_URL);
  if (response.status !== 200 || payloadCode(response) !== 0) {
    throw failure(response, "cookie/refresh");
  }

  const nextRefreshToken = (response.data as ApiPayload | undefined)?.data
    ?.refresh_token;
  keepAuthCookiesAsSession(jar);
  writeCookieJarToNetscape(jar, file);
  if (typeof nextRefreshToken === "string" && nextRefreshToken) {
    writeRefreshToken(file, nextRefreshToken);
  } else {
    logger.warn(
      `[uid=${account.uid}] Bilibili cookie refresh returned no refresh_token; keeping the old one`,
    );
  }

  const nextCsrf = cookieValue(jar, "bili_jct");
  if (!nextCsrf) throw new Error("refreshed cookies are missing bili_jct");
  const confirm = await http.post(
    CONFIRM_URL,
    new URLSearchParams({
      csrf: nextCsrf,
      refresh_token: refreshToken,
    }),
    {
      headers: headers(
        account,
        cookieHeader(account, false),
        "application/x-www-form-urlencoded",
      ),
    },
  );
  applySetCookie(jar, confirm, CONFIRM_URL);
  if (confirm.status !== 200 || payloadCode(confirm) !== 0) {
    logger.warn(
      `[uid=${account.uid}] Bilibili cookie refresh confirmation failed: ${
        failure(confirm, "confirm/refresh").message
      }`,
    );
  } else {
    logger.info(`[uid=${account.uid}] Bilibili cookies refreshed`);
  }
  return true;
}

/**
 * Performs Bilibili's passport cookie refresh when `<cookie file>.refresh_token`
 * exists. The sidecar is updated in place after every successful rotation.
 */
export class CookieRefreshService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly accounts: AccountContext[]) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshAll();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
