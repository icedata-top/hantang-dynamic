import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randUA } from "@ahmedrangel/rand-user-agent";
import axios, { type AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import qrcode from "qrcode-terminal";
import { CookieJar } from "tough-cookie";
import {
  getDedeUserIDFromCookieFile,
  writeCookieJarToNetscape,
} from "../utils/cookieFile";
import { refreshTokenPath, writeRefreshToken } from "../utils/refreshTokenFile";
import {
  ACCOUNT_NAME_RE,
  accountNameFromUname,
  addCookieFileToToml,
  cookieFilePath,
  cookieFilePathsFromToml,
} from "./configCookieFile";

const PASSPORT = "https://passport.bilibili.com/x/passport-login/web";
const QR_TIMEOUT_MS = 180_000;
type JarDefaults = AxiosInstance["defaults"] & { jar?: CookieJar };
const wrapWithCookieJar = wrapper as unknown as (
  instance: AxiosInstance,
) => AxiosInstance;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseArgs(args: string[]): {
  account?: string;
  configPath: string;
  updateConfig: boolean;
} {
  const account =
    argument(args, "--account") ??
    args.find(
      (arg, index) =>
        !arg.startsWith("-") &&
        args[index - 1] !== "--config" &&
        args[index - 1] !== "--account",
    );
  if (account !== undefined && !ACCOUNT_NAME_RE.test(account)) {
    throw new Error(
      "Usage: pnpm login-qr [account] [--config config.toml] [--no-config]\n" +
        "Account names may contain letters, digits, dots, underscores, and dashes.",
    );
  }
  return {
    account,
    configPath: argument(args, "--config") ?? "config.toml",
    updateConfig: !args.includes("--no-config"),
  };
}

export async function runLoginQr(args: string[]): Promise<void> {
  const { account, configPath, updateConfig } = parseArgs(args);
  const jar = new CookieJar();
  const client = wrapWithCookieJar(
    axios.create({
      timeout: 30_000,
      maxRedirects: 0,
      validateStatus: () => true,
    }),
  );
  (client.defaults as JarDefaults).jar = jar;
  client.defaults.withCredentials = true;
  client.defaults.headers.common["User-Agent"] = randUA();
  client.defaults.headers.common.Referer = "https://www.bilibili.com";

  const generated = await client.get(`${PASSPORT}/qrcode/generate`);
  const gen = generated.data as {
    code?: number;
    message?: string;
    data?: { url?: string; qrcode_key?: string };
  };
  if (gen.code !== 0 || !gen.data?.url || !gen.data.qrcode_key) {
    throw new Error(`qrcode/generate failed: ${gen.code} ${gen.message ?? ""}`);
  }

  console.log(`Account: ${account ?? "auto (from Bilibili profile)"}`);
  qrcode.generate(gen.data.url, { small: true });
  console.log("Scan with the Bilibili app. Waiting up to 180 seconds...");

  const deadline = Date.now() + QR_TIMEOUT_MS;
  let lastStatus = -1;
  while (Date.now() < deadline) {
    await sleep(1500);
    const polled = await client.get(`${PASSPORT}/qrcode/poll`, {
      params: { qrcode_key: gen.data.qrcode_key },
    });
    const body = polled.data as {
      code?: number;
      message?: string;
      data?: {
        code?: number;
        message?: string;
        refresh_token?: string;
      };
    };
    const status = body.data;
    if (!status || typeof status.code !== "number") {
      throw new Error(`qrcode/poll failed: ${body.code} ${body.message ?? ""}`);
    }
    if (status.code !== lastStatus) {
      console.log(status.message ?? `status ${status.code}`);
      lastStatus = status.code;
    }
    if (status.code === 0) {
      const uid = jar
        .getCookiesSync("https://www.bilibili.com/", { allPaths: true })
        .find((cookie) => cookie.key === "DedeUserID")?.value;
      if (!uid) throw new Error("Login succeeded but DedeUserID is missing");
      if (!status.refresh_token) {
        throw new Error("Login succeeded but refresh_token is missing");
      }

      const nav = await client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .catch(() => null);
      const profile = (nav?.data as { data?: { uname?: string } } | undefined)
        ?.data;
      const absoluteConfig = resolve(process.cwd(), configPath);
      const previous = existsSync(absoluteConfig)
        ? readFileSync(absoluteConfig, "utf-8")
        : "";
      const existingPath = account
        ? null
        : cookieFilePathsFromToml(previous).find(
            (path) => getDedeUserIDFromCookieFile(path) === uid,
          );
      const cookiePath =
        existingPath ??
        cookieFilePath(
          account ?? accountNameFromUname(profile?.uname ?? "", uid),
        );

      const spi = await client
        .get("https://api.bilibili.com/x/frontend/finger/spi")
        .catch(() => null);
      const finger = (spi?.data as { data?: { b_3?: string; b_4?: string } })
        ?.data;
      if (finger?.b_3) {
        jar.setCookieSync(
          `buvid3=${finger.b_3}; Domain=.bilibili.com; Path=/`,
          "https://www.bilibili.com/",
        );
      }
      if (finger?.b_4) {
        jar.setCookieSync(
          `buvid4=${finger.b_4}; Domain=.bilibili.com; Path=/`,
          "https://www.bilibili.com/",
        );
      }

      if (!writeCookieJarToNetscape(jar, cookiePath)) {
        throw new Error(`Failed to write ${cookiePath}`);
      }
      writeRefreshToken(cookiePath, status.refresh_token);

      if (updateConfig) {
        const updated = addCookieFileToToml(previous, cookiePath);
        if (updated !== previous) {
          writeFileSync(`${absoluteConfig}.tmp`, updated);
          renameSync(`${absoluteConfig}.tmp`, absoluteConfig);
          console.log(`Updated ${absoluteConfig}`);
        } else {
          console.log(`${absoluteConfig} already references ${cookiePath}`);
        }
      }

      const names = jar
        .getCookiesSync("https://www.bilibili.com/", { allPaths: true })
        .map((cookie) => cookie.key)
        .join(", ");
      console.log(
        `Logged in as uid=${uid}${profile?.uname ? ` (${profile.uname})` : ""}`,
      );
      console.log(`Cookies (${names}): ${cookiePath}`);
      console.log(`Refresh token: ${refreshTokenPath(cookiePath)}`);
      console.log("Restart the service to use this account.");
      return;
    }
    if (status.code === 86038) {
      throw new Error("QR expired; run the command again");
    }
  }
  throw new Error("Timed out waiting for QR scan");
}
