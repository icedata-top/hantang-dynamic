import * as fs from "node:fs";
import { CookieJar } from "tough-cookie";
import { logger } from "./logger";

/**
 * Represents a parsed Netscape cookie entry.
 */
interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

/**
 * Cookies that carry authentication state. Losing them turns every request
 * into an anonymous request and Bilibili answers with `-101 账号未登录`.
 */
const AUTH_COOKIE_NAMES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "b_lsid",
]);

/**
 * Auth cookies that must never be silently dropped when persisting a jar.
 * `b_lsid` is excluded because it is short-lived and refreshed frequently.
 */
const CRITICAL_COOKIE_NAMES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
]);

/** Absolute expiry from the Netscape `expires` column, or null for session cookies. */
function cookieExpiryMs(cookie: NetscapeCookie): number | null {
  return cookie.expires > 0 ? cookie.expires * 1000 : null;
}

/**
 * SESSDATA embeds its own expiry as `<hash>,<expiresAt>,<md5>`. Prefer it over
 * the Netscape column because stale exports often keep a misleading column.
 */
function sessdataExpiryMs(value: string): number | null {
  try {
    const parts = decodeURIComponent(value).split(",");
    if (parts.length < 2) return null;
    const expiresAt = Number.parseInt(parts[1], 10);
    return Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt * 1000
      : null;
  } catch {
    return null;
  }
}

function formatExpiry(expiryMs: number): string {
  return new Date(expiryMs).toISOString();
}

/**
 * Read all cookie entries from a Netscape file without validating them.
 * Throws when the file does not exist.
 */
function readNetscapeCookieFile(
  filePath: string,
  logMalformed = true,
): NetscapeCookie[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cookie file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const cookies: NetscapeCookie[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();

    // Skip empty lines
    if (!line) continue;

    // Check for HttpOnly prefix
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.substring(10); // Remove "#HttpOnly_" prefix
    } else if (line.startsWith("#")) {
      // Regular comment line, skip
      continue;
    }

    // Support both tab-separated (standard) and space-separated (Cookie-Editor) formats
    let parts = line.split("\t");
    if (parts.length < 7) {
      // Try splitting by whitespace (for Cookie-Editor exports that use spaces)
      parts = line.split(/\s+/);
    }
    if (parts.length < 7) {
      if (logMalformed) {
        logger.warn(`Skipping malformed cookie line: ${line}`);
      }
      continue;
    }

    const [domain, includeSubdomains, path, secure, expires, name, value] =
      parts;

    cookies.push({
      domain,
      includeSubdomains: includeSubdomains === "TRUE",
      path,
      secure: secure === "TRUE",
      expires: Number.parseInt(expires, 10),
      name,
      value,
      httpOnly,
    });
  }

  return cookies;
}

/**
 * Parse a Netscape format cookie file into an array of cookie objects.
 * Format: domain<TAB>includeSubdomains<TAB>path<TAB>secure<TAB>expires<TAB>name<TAB>value
 *
 * Lines starting with # are comments, except #HttpOnly_ prefix indicates HttpOnly flag.
 *
 * Fails when SESSDATA is missing or already expired, because the account would
 * otherwise load successfully and then spam `-101 账号未登录` on every request.
 */
export function parseNetscapeCookieFile(filePath: string): NetscapeCookie[] {
  const cookies = readNetscapeCookieFile(filePath);

  // Validate SESSDATA exists (required for authentication)
  const sessdata = cookies.find((c) => c.name === "SESSDATA");
  if (!sessdata) {
    throw new Error(
      `Cookie file ${filePath} does not contain SESSDATA. Authentication will fail.`,
    );
  }

  const now = Date.now();
  const sessdataExpiries = [
    cookieExpiryMs(sessdata),
    sessdataExpiryMs(sessdata.value),
  ].filter((expiry): expiry is number => expiry !== null);
  const sessdataExpiry =
    sessdataExpiries.length > 0
      ? Math.min(...sessdataExpiries)
      : Number.POSITIVE_INFINITY;

  if (sessdataExpiry <= now) {
    throw new Error(
      `Cookie file ${filePath} contains an expired SESSDATA (expired at ${formatExpiry(
        sessdataExpiry,
      )}). Log in again and re-export the cookies.`,
    );
  }

  const expiredAuthCookies = cookies
    .filter((c) => AUTH_COOKIE_NAMES.has(c.name) && c.name !== "SESSDATA")
    .map((c) => ({ name: c.name, expiry: cookieExpiryMs(c) }))
    .filter(
      (c): c is { name: string; expiry: number } =>
        c.expiry !== null && c.expiry <= now,
    );

  if (expiredAuthCookies.length > 0) {
    logger.warn(
      `Cookie file ${filePath} contains expired authentication cookie(s): ` +
        expiredAuthCookies
          .map((c) => `${c.name} (expired at ${formatExpiry(c.expiry)})`)
          .join(", ") +
        ". They will not be sent to Bilibili; re-export the cookies if these are still required.",
    );
  }

  logger.info(`Loaded ${cookies.length} cookies from ${filePath}`);
  return cookies;
}

/**
 * Create a CookieJar from an array of parsed Netscape cookies.
 *
 * Expired cookies are skipped instead of being handed to tough-cookie, because
 * `getCookiesSync` purges them later and they would otherwise disappear from
 * the jar without any explanation in the logs.
 */
export function createCookieJarFromNetscape(
  cookies: NetscapeCookie[],
  sourceLabel?: string,
): CookieJar {
  const jar = new CookieJar();
  const now = Date.now();
  const expired: string[] = [];
  const rejected: string[] = [];

  for (const c of cookies) {
    const expiry = cookieExpiryMs(c);
    if (expiry !== null && expiry <= now) {
      expired.push(`${c.name} (expired at ${formatExpiry(expiry)})`);
      continue;
    }

    try {
      // Determine protocol based on secure flag
      const protocol = c.secure ? "https" : "http";
      // Remove leading dot from domain for URL (if present)
      const urlDomain = c.domain.startsWith(".")
        ? c.domain.substring(1)
        : c.domain;
      // Build URL for the cookie - use a subdomain to ensure proper domain cookie matching
      const url = `${protocol}://www.${urlDomain}${c.path}`;

      // Build cookie string format which tough-cookie v6 handles correctly
      // Domain attribute should NOT have leading dot per RFC 6265
      const domainForAttr = c.domain.startsWith(".")
        ? c.domain.substring(1)
        : c.domain;

      // Build cookie parts
      const parts: string[] = [`${c.name}=${c.value}`];
      parts.push(`Domain=${domainForAttr}`);
      parts.push(`Path=${c.path}`);
      if (c.secure) parts.push("Secure");
      if (c.httpOnly) parts.push("HttpOnly");
      if (c.expires > 0) {
        parts.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
      }

      const cookieString = parts.join("; ");
      jar.setCookieSync(cookieString, url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rejected.push(`${c.name} (${reason})`);
    }
  }

  const source = sourceLabel ? ` from ${sourceLabel}` : "";
  if (expired.length > 0) {
    logger.warn(
      `Skipping ${expired.length} expired cookie(s)${source}: ${expired.join(", ")}`,
    );
  }
  if (rejected.length > 0) {
    logger.warn(
      `Failed to add ${rejected.length} cookie(s)${source}: ${rejected.join(", ")}`,
    );
  }

  const accepted = cookies.length - expired.length - rejected.length;
  const stored = jar.serializeSync()?.cookies.length ?? 0;
  if (stored < accepted) {
    logger.warn(
      `Cookie jar${source} stored ${stored} of ${accepted} accepted cookies; ` +
        "the remaining cookies were rejected by tough-cookie (domain or path mismatch).",
    );
  }

  return jar;
}

/**
 * Write a CookieJar back to a Netscape format cookie file.
 */
export function writeCookieJarToNetscape(
  jar: CookieJar,
  filePath: string,
): void {
  try {
    // Use serializeSync to get all cookies from the jar (avoids hardcoding domains)
    const serialized = jar.serializeSync();
    if (!serialized) {
      logger.warn(`Failed to serialize cookie jar for ${filePath}`);
      return;
    }
    const uniqueCookies = serialized.cookies;

    // Never clobber a cookie file when the in-memory jar has lost auth cookies.
    // This happens after tough-cookie purges expired cookies, and persisting it
    // would permanently delete SESSDATA/DedeUserID from disk.
    if (fs.existsSync(filePath)) {
      const existingCookies = readNetscapeCookieFile(filePath, false);
      const jarCookieNames = new Set(uniqueCookies.map((c) => c.key));
      const lostCookies = [
        ...new Set(
          existingCookies
            .map((c) => c.name)
            .filter(
              (name) =>
                CRITICAL_COOKIE_NAMES.has(name) && !jarCookieNames.has(name),
            ),
        ),
      ];

      if (lostCookies.length > 0) {
        logger.warn(
          `Refusing to persist cookies to ${filePath}: the in-memory jar no longer contains ${lostCookies.join(
            ", ",
          )}. The existing file was left untouched to avoid destroying authentication cookies.`,
        );
        return;
      }
    }

    const lines: string[] = [
      "# Netscape HTTP Cookie File",
      "# http://curl.haxx.se/rfc/cookie_spec.html",
      "# This file was generated by hantang-dynamic",
    ];

    for (const c of uniqueCookies) {
      const prefix = c.httpOnly ? "#HttpOnly_" : "";
      const domain = (c.domain as string) || ".bilibili.com";
      const includeSubdomains = c.hostOnly ? "FALSE" : "TRUE";
      const path = (c.path as string) || "/";
      const secure = c.secure ? "TRUE" : "FALSE";
      // SerializedCookie.expires is string (ISO) or undefined
      let expires = "0";
      if (c.expires && c.expires !== "Infinity") {
        const expDate = new Date(c.expires as string);
        if (!Number.isNaN(expDate.getTime())) {
          expires = Math.floor(expDate.getTime() / 1000).toString();
        }
      }
      const name = c.key;
      const value = c.value;

      lines.push(
        `${prefix}${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expires}\t${name}\t${value}`,
      );
    }

    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
    logger.debug(`Persisted ${uniqueCookies.length} cookies to ${filePath}`);
  } catch (error) {
    logger.warn(`Failed to persist cookies to ${filePath}: ${error}`);
  }
}

/**
 * Extract the DedeUserID cookie value directly from a Netscape cookie file.
 * Returns null if the cookie is not found or the file cannot be read.
 */
export function getDedeUserIDFromCookieFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#HttpOnly_")) {
        line = line.substring(10);
      } else if (line.startsWith("#")) {
        continue;
      }
      const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/);
      if (parts.length >= 7 && parts[5] === "DedeUserID") {
        return parts[6] || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all cookies from the jar as a semicolon-separated string for use in Cookie header.
 */
export function getAllCookiesAsString(
  jar: CookieJar,
  domainPattern = "bilibili.com",
): string {
  try {
    const url = domainPattern.startsWith("www.")
      ? `https://${domainPattern}`
      : `https://www.${domainPattern}`;
    const cookies = jar.getCookiesSync(url, { allPaths: true });
    return cookies.map((c) => `${c.key}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/**
 * Extract a specific cookie value from the jar by name and optional domain pattern.
 */
export function getCookieValue(
  jar: CookieJar,
  name: string,
  domainPattern = "bilibili.com",
): string | null {
  try {
    // Use "www." prefix to ensure proper matching of ".bilibili.com" domain cookies
    // tough-cookie requires a valid subdomain to match domain cookies with leading dots
    const url = domainPattern.startsWith("www.")
      ? `https://${domainPattern}`
      : `https://www.${domainPattern}`;
    const cookies = jar.getCookiesSync(url, {
      allPaths: true,
    });
    const cookie = cookies.find((c) => c.key === name);
    return cookie?.value ?? null;
  } catch {
    return null;
  }
}
