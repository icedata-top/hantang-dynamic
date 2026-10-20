import { parse } from "smol-toml";

export const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function cookieFilePath(account: string): string {
  return `./.cookies.${account}.txt`;
}

type CookieEntry = string | { path: string; enable_watch_later: boolean };

function entryPath(entry: CookieEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

function entriesFromConfig(data: unknown): CookieEntry[] {
  const bilibili = (data as { bilibili?: Record<string, unknown> }).bilibili;
  if (!bilibili) return [];

  const entries: CookieEntry[] = [];
  const cookieFiles = bilibili.cookie_files;
  const hasCookieFiles = Array.isArray(cookieFiles);
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
    !hasCookieFiles &&
    typeof single === "string" &&
    single &&
    !entries.some((entry) => entryPath(entry) === single)
  ) {
    entries.push(single);
  }
  return entries;
}

function formatEntry(entry: CookieEntry): string {
  return typeof entry === "string"
    ? JSON.stringify(entry)
    : `{ path = ${JSON.stringify(entry.path)}, enable_watch_later = ${entry.enable_watch_later} }`;
}

function sectionBounds(
  lines: string[],
  name: string,
): { start: number; end: number } | null {
  const header = new RegExp(`^\\s*\\[${name}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function assignmentRange(
  lines: string[],
  start: number,
  end: number,
  key: string,
): { start: number; end: number } | null {
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  const first = lines.findIndex(
    (line, index) => index >= start && index < end && assignment.test(line),
  );
  if (first < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = first; i < end; i++) {
    const line = lines[i];
    const from = i === first ? line.indexOf("=") + 1 : 0;
    for (let j = from; j < line.length; j++) {
      const char = line[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "[" || char === "{") {
        depth++;
      } else if (char === "]" || char === "}") {
        depth--;
      } else if (char === "#") {
        break;
      }
    }
    if (depth <= 0 && quote === null) return { start: first, end: i + 1 };
  }
  return { start: first, end };
}

/**
 * Add a cookie file to the `[bilibili]` section without rewriting unrelated
 * lines. Existing cookie_files entries, including Watch Later objects, are kept.
 */
export function addCookieFileToToml(content: string, newPath: string): string {
  const parsed = parse(content);
  const entries = entriesFromConfig(parsed);
  if (entries.some((entry) => entryPath(entry) === newPath)) return content;
  entries.push(newPath);

  const bilibili = (parsed as { bilibili?: Record<string, unknown> }).bilibili;
  const usesCookieFiles = Array.isArray(bilibili?.cookie_files);
  const single = bilibili?.cookie_file;
  const useSingle = !usesCookieFiles && (!single || single === newPath);

  const lines = content.split(/\r?\n/);
  const bounds = sectionBounds(lines, "bilibili");
  if (!bounds) {
    const block = useSingle
      ? `[bilibili]\ncookie_file = ${JSON.stringify(newPath)}`
      : `[bilibili]\ncookie_files = [${entries.map(formatEntry).join(", ")}]`;
    return `${content.trimEnd()}\n\n${block}\n`;
  }

  if (useSingle) {
    const value = `cookie_file = ${JSON.stringify(newPath)}`;
    const range = assignmentRange(
      lines,
      bounds.start,
      bounds.end,
      "cookie_file",
    );
    if (range) lines.splice(range.start, range.end - range.start, value);
    else lines.splice(bounds.start + 1, 0, value);
  } else {
    const value = `cookie_files = [${entries.map(formatEntry).join(", ")}]`;
    const range = assignmentRange(
      lines,
      bounds.start,
      bounds.end,
      "cookie_files",
    );
    if (range) {
      lines.splice(range.start, range.end - range.start, value);
    } else {
      const singleRange = assignmentRange(
        lines,
        bounds.start,
        bounds.end,
        "cookie_file",
      );
      lines.splice(singleRange ? singleRange.end : bounds.start + 1, 0, value);
    }
  }

  const updated = lines.join("\n");
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}
