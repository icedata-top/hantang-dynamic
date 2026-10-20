import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const REFRESH_TOKEN_SUFFIX = ".refresh_token";

export function refreshTokenPath(cookieFilePath: string): string {
  return `${cookieFilePath}${REFRESH_TOKEN_SUFFIX}`;
}

export function readRefreshToken(cookieFilePath: string): string | null {
  const path = refreshTokenPath(cookieFilePath);
  return existsSync(path) ? readFileSync(path, "utf-8").trim() || null : null;
}

export function writeRefreshToken(cookieFilePath: string, token: string): void {
  const path = refreshTokenPath(cookieFilePath);
  writeFileSync(`${path}.tmp`, `${token}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
