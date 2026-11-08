import { parse } from "smol-toml";

export const ACCOUNT_NAME_RE = /^[\p{L}\p{N}._-]+$/u;

export function cookieFilePath(account: string): string {
  return `./.cookies.${account}.txt`;
}

export function accountNameFromUname(uname: string, uid: string): string {
  const cleaned = uname
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || uid;
}

type CookieEntry = string | { path: string; enable_watch_later: boolean };

function entryPath(entry: CookieEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

function entriesFrom(data: unknown): CookieEntry[] {
  const bilibili = (data as { bilibili?: Record<string, unknown> }).bilibili;
  if (!bilibili) return [];

  const cookieFiles = bilibili.cookie_files;
  const entries: CookieEntry[] = [];
  if (Array.isArray(cookieFiles)) {
    for (const item of cookieFiles) {
      if (typeof item === "string") {
        entries.push(item);
      } else if (
        item &&
        typeof item === "object" &&
        typeof (item as { path?: unknown }).path === "string"
      ) {
        entries.push({
          path: (item as { path: string }).path,
          enable_watch_later:
            (item as { enable_watch_later?: unknown }).enable_watch_later ===
            true,
        });
      }
    }
  }

  const single = bilibili.cookie_file;
  if (
    !Array.isArray(cookieFiles) &&
    typeof single === "string" &&
    single &&
    !entries.some((entry) => entryPath(entry) === single)
  ) {
    entries.push(single);
  }
  return entries;
}

export function cookieFilePathsFromToml(content: string): string[] {
  return entriesFrom(parse(content)).map(entryPath);
}

function formatEntry(entry: CookieEntry): string {
  return typeof entry === "string"
    ? JSON.stringify(entry)
    : `{ path = ${JSON.stringify(entry.path)}, enable_watch_later = ${entry.enable_watch_later} }`;
}

function sectionBounds(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) =>
    /^\s*\[bilibili\]\s*(?:#.*)?$/.test(line),
  );
  if (start < 0) return null;
  const end = lines.findIndex(
    (line, index) => index > start && /^\s*\[/.test(line),
  );
  return { start, end: end < 0 ? lines.length : end };
}

function assignmentRange(
  lines: string[],
  start: number,
  end: number,
  key: string,
): { start: number; end: number } | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const first = lines.findIndex(
    (line, index) => index >= start && index < end && pattern.test(line),
  );
  if (first < 0) return null;
  if (!lines[first].includes("[")) return { start: first, end: first + 1 };

  const close = lines.findIndex(
    (line, index) => index > first && index < end && /^\s*\]/.test(line),
  );
  return { start: first, end: close < 0 ? first + 1 : close + 1 };
}

/**
 * Add a cookie file to `[bilibili]`, preserving other lines and existing
 * cookie_files entries (including Watch Later objects).
 */
export function addCookieFileToToml(content: string, newPath: string): string {
  const parsed = parse(content);
  const entries = entriesFrom(parsed);
  if (entries.some((entry) => entryPath(entry) === newPath)) return content;
  entries.push(newPath);

  const bilibili = (parsed as { bilibili?: Record<string, unknown> }).bilibili;
  const single = bilibili?.cookie_file;
  const useSingle =
    !Array.isArray(bilibili?.cookie_files) && (!single || single === newPath);

  const lines = content.split(/\r?\n/);
  const bounds = sectionBounds(lines);
  if (!bounds) {
    const block = useSingle
      ? `[bilibili]\ncookie_file = ${JSON.stringify(newPath)}`
      : `[bilibili]\ncookie_files = [${entries.map(formatEntry).join(", ")}]`;
    return `${content.trimEnd()}\n\n${block}\n`;
  }

  const key = useSingle ? "cookie_file" : "cookie_files";
  const value = useSingle
    ? `cookie_file = ${JSON.stringify(newPath)}`
    : `cookie_files = [${entries.map(formatEntry).join(", ")}]`;
  const range = assignmentRange(lines, bounds.start, bounds.end, key);
  if (range) {
    lines.splice(range.start, range.end - range.start, value);
  } else {
    const anchor = useSingle
      ? null
      : assignmentRange(lines, bounds.start, bounds.end, "cookie_file");
    lines.splice(anchor ? anchor.end : bounds.start + 1, 0, value);
  }

  const updated = lines.join("\n");
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}
