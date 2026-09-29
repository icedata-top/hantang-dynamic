import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  createWhitelistConfig,
  legacyWhitelistPaths,
} from "./schemas/whitelist";

type Toml = Record<string, unknown>;

function atPath(data: unknown, path: string): unknown {
  let value = data;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !(part in value)) {
      return undefined;
    }
    value = (value as Toml)[part];
  }
  return value;
}

function parseConfig(source: string): Toml {
  try {
    return parseToml(source);
  } catch {
    throw new Error(
      "config.toml is invalid TOML; fix it before whitelist migration.",
    );
  }
}

function arrayEnd(
  lines: string[],
  start: number,
  value: string,
  path: string,
): number {
  if (value.includes('"""') || value.includes("'''")) {
    throw new Error(
      `Cannot automatically migrate ${path}: multiline strings are unsupported.`,
    );
  }
  if (!value.trimStart().startsWith("[")) return start;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let row = start; row < lines.length; row++) {
    const part = row === start ? value : lines[row];
    if (part.includes('"""') || part.includes("'''")) {
      throw new Error(
        `Cannot automatically migrate ${path}: multiline strings are unsupported.`,
      );
    }
    for (const char of part) {
      if (quote) {
        if (quote === '"' && !escaped && char === "\\") escaped = true;
        else {
          if (!escaped && char === quote) quote = undefined;
          escaped = false;
        }
      } else if (char === "#") break;
      else if (char === '"' || char === "'") quote = char;
      else if (char === "[") depth++;
      else if (char === "]") {
        depth--;
        if (depth === 0) return row;
      }
    }
  }
  throw new Error(
    `Cannot automatically migrate ${path}: array assignment is incomplete.`,
  );
}

export function migrateWhitelistText(source: string): string {
  const parsed = parseConfig(source);
  const present = legacyWhitelistPaths.filter(
    ([oldPath]) => atPath(parsed, oldPath) !== undefined,
  );
  if (present.length === 0) return source;
  if (
    source
      .split(/\r?\n/)
      .some(
        (line) =>
          !line.trimStart().startsWith("#") &&
          (line.includes('"""') || line.includes("'''")),
      )
  ) {
    throw new Error(
      "Cannot automatically migrate config.toml containing multiline strings; move legacy whitelist keys manually.",
    );
  }
  for (const [oldPath, newPath] of present) {
    if (atPath(parsed, newPath) !== undefined) {
      throw new Error(
        `Cannot migrate ${oldPath}: ${newPath} already exists in config.toml.`,
      );
    }
  }

  const lines = source.split(/(?<=\n)/);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const sections = new Map<string, { end: number }>();
  const assignments = new Map<
    string,
    { start: number; end: number; text: string }
  >();
  let section = "";
  for (let row = 0; row < lines.length; row++) {
    const currentLine = lines[row].replace(/\r?\n$/, "");
    const header = currentLine.match(/^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/);
    if (header) {
      const previous = sections.get(section);
      if (previous) previous.end = row;
      section = header[1];
      sections.set(section, { end: lines.length });
      continue;
    }
    if (/^\s*\[/.test(currentLine)) {
      const previous = sections.get(section);
      if (previous) previous.end = row;
      section = "";
      continue;
    }
    const assignment = currentLine.match(/^(\s*)([A-Za-z0-9_-]+)(\s*=)(.*)$/);
    if (!assignment) continue;
    const path = section ? `${section}.${assignment[2]}` : assignment[2];
    if (!present.some(([oldPath]) => oldPath === path)) continue;
    const end = arrayEnd(lines, row, assignment[4], path);
    assignments.set(path, {
      start: row,
      end,
      text: lines.slice(row, end + 1).join(""),
    });
    row = end;
  }

  const insertions = new Map<number, string[]>();
  const removed = new Set<number>();
  const newSections = new Map<string, string[]>();
  for (const [oldPath, newPath] of present) {
    const match = assignments.get(oldPath);
    if (!match) {
      throw new Error(
        `Cannot automatically migrate ${oldPath}: use bare table headers and keys, or move this key manually.`,
      );
    }
    const pieces = newPath.split(".");
    const key = pieces.pop();
    const destination = pieces.join(".");
    if (!key) throw new Error(`Invalid whitelist destination for ${oldPath}.`);
    const renamed = match.text.replace(
      /^(\s*)[A-Za-z0-9_-]+(\s*=)/,
      `$1${key}$2`,
    );
    const statement = renamed.endsWith("\n") ? renamed : `${renamed}${newline}`;
    const target = sections.get(destination);
    if (target) {
      const pending = insertions.get(target.end) ?? [];
      pending.push(statement);
      insertions.set(target.end, pending);
    } else {
      const pending = newSections.get(destination) ?? [];
      pending.push(statement);
      newSections.set(destination, pending);
    }
    for (let row = match.start; row <= match.end; row++) removed.add(row);
  }

  let result = "";
  for (let row = 0; row <= lines.length; row++) {
    const pending = insertions.get(row);
    if (pending) {
      if (result.length > 0 && !result.endsWith("\n")) result += newline;
      result += pending.join("");
    }
    if (row < lines.length && !removed.has(row)) result += lines[row];
  }
  for (const [sectionName, statements] of newSections) {
    if (result.length > 0 && !result.endsWith("\n")) result += newline;
    result += `${newline}[${sectionName}]${newline}${statements.join("")}`;
  }
  verifyMigration(parsed, parseConfig(result), present);
  return result;
}

function verifyMigration(
  original: Toml,
  migrated: Toml,
  present: (typeof legacyWhitelistPaths)[number][],
): void {
  for (const [oldPath, newPath] of present) {
    if (atPath(migrated, oldPath) !== undefined) {
      throw new Error(`Whitelist migration left ${oldPath} in config.toml.`);
    }
    if (
      !isDeepStrictEqual(atPath(migrated, newPath), atPath(original, oldPath))
    ) {
      throw new Error(`Whitelist migration changed the value for ${newPath}.`);
    }
  }
}

export function loadConfigToml(configPath: string): Toml {
  const source = readFileSync(configPath, "utf-8");
  const original = parseConfig(source);
  const present = legacyWhitelistPaths.filter(
    ([oldPath]) => atPath(original, oldPath) !== undefined,
  );
  const migrated = migrateWhitelistText(source);
  if (migrated === source) return original;
  const stat = lstatSync(configPath);
  if (!stat.isFile()) {
    throw new Error(
      "config.toml must be a regular file; symlinks cannot be migrated automatically.",
    );
  }
  const migratedData = parseConfig(migrated);
  createWhitelistConfig((tomlPath, envKey, defaultValue) => {
    const value = atPath(migratedData, tomlPath.join("."));
    if (value !== undefined && value !== "") return value;
    const envValue = process.env[envKey];
    return envValue !== undefined && envValue !== "" ? envValue : defaultValue;
  });

  const directory = dirname(configPath);
  const name = basename(configPath);
  const backup = join(directory, `${name}.backup-${randomUUID()}`);
  const temporary = join(directory, `${name}.tmp-${randomUUID()}`);
  let backupMade = false;
  let replaced = false;
  try {
    copyFileSync(configPath, backup, constants.COPYFILE_EXCL);
    backupMade = true;
    if (readFileSync(backup, "utf-8") !== source) {
      throw new Error(
        "config.toml changed during whitelist migration; retry after stopping other editors.",
      );
    }
    const handle = openSync(temporary, "wx", stat.mode);
    try {
      writeFileSync(handle, migrated, "utf-8");
    } finally {
      closeSync(handle);
    }
    chmodSync(temporary, stat.mode);
    verifyMigration(
      original,
      parseConfig(readFileSync(temporary, "utf-8")),
      present,
    );
    if (readFileSync(configPath, "utf-8") !== source) {
      throw new Error(
        "config.toml changed during whitelist migration; retry after stopping other editors.",
      );
    }
    renameSync(temporary, configPath);
    replaced = true;
    const result = parseConfig(readFileSync(configPath, "utf-8"));
    verifyMigration(original, result, present);
    rmSync(backup);
    backupMade = false;
    return result;
  } catch (error) {
    if (replaced && backupMade) renameSync(backup, configPath);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    if (!replaced) rmSync(backup, { force: true });
  }
}
