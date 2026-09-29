import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ConfigTomlParseError, loadConfigToml } from "./migrate-whitelist";

function configFile(
  t: { after: (fn: () => void) => void },
  source: string,
): string {
  const directory = mkdtempSync(join(tmpdir(), "whitelist-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "config.toml");
  writeFileSync(file, source, { mode: 0o600 });
  return file;
}

test("migrates all legacy keys while preserving values, comments, and mode", (t) => {
  const original = `# global comment
# body = '''
[processing.filtering]
content_blacklist = ["spam"] # keep
content_whitelist = [
  "music", # inside array
  "dance",
] # keyword comment
type_id_whitelist = [28] # type comment
copyright_whitelist = [1]
pid_v2_whitelist = [7]

[minute]
bootstrap_label_content_types = ["vocaloid"]
bootstrap_label_origin = "rule" # origin comment
bootstrap_label_writers = ["classification_apply"]
bootstrap_tid_v2_allowlist = [2022]

[whitelist.video]
# existing destination section
`;
  const file = configFile(t, original);
  const parsed = loadConfigToml(file);
  const migrated = readFileSync(file, "utf-8");
  assert.deepEqual(parsed.whitelist, {
    video: {
      content_keywords: ["music", "dance"],
      type_ids: [28],
      copyright_types: [1],
    },
    recommendation: { pid_v2: [7] },
    minute_bootstrap: {
      label_content_types: ["vocaloid"],
      label_origin: "rule",
      label_writers: ["classification_apply"],
      tid_v2: [2022],
    },
  });
  assert.match(migrated, /content_blacklist = \["spam"\] # keep/);
  assert.match(migrated, /"music", # inside array/);
  assert.match(migrated, /type_ids = \[28\] # type comment/);
  assert.match(migrated, /label_origin = "rule" # origin comment/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(file, "..")), ["config.toml"]);
  assert.deepEqual(loadConfigToml(file).whitelist, parsed.whitelist);
  assert.equal(readFileSync(file, "utf-8"), migrated);
});

test("inline triple-quote comments do not block migration", (t) => {
  const source = `[processing.filtering]\ncontent_whitelist = ["music"] # example: """text"""\n`;
  const file = configFile(t, source);
  loadConfigToml(file);
  assert.match(
    readFileSync(file, "utf-8"),
    /content_keywords = \["music"\] # example: """text"""/,
  );
});

test("actual multiline strings still require manual migration", (t) => {
  const source = `[processing.filtering]\ncontent_whitelist = ["music"]\ndescription = """first\nsecond"""\n`;
  const file = configFile(t, source);
  assert.throws(() => loadConfigToml(file), /multiline strings/);
  assert.equal(readFileSync(file, "utf-8"), source);
});

test("attached comments follow their legacy key, but separated section comments stay", (t) => {
  const source = `[processing.filtering]\n# section guidance\n\n# keywords for this video\n# keep this note with the key\ncontent_whitelist = ["music"]\ncontent_blacklist = ["spam"]\n`;
  const file = configFile(t, source);
  loadConfigToml(file);
  const migrated = readFileSync(file, "utf-8");
  assert.match(
    migrated,
    /\[processing\.filtering\]\n# section guidance\n\ncontent_blacklist/,
  );
  assert.match(
    migrated,
    /\[whitelist\.video\]\n# keywords for this video\n# keep this note with the key\ncontent_keywords = \["music"\]/,
  );
});

test("conflicts and unsupported old key forms leave config.toml unchanged", (t) => {
  for (const source of [
    `[processing.filtering]\ncontent_whitelist = ["music"]\n[whitelist.video]\ncontent_keywords = ["dance"]\n`,
    `[processing.filtering]\n"content_whitelist" = ["music"]\n`,
    `processing.filtering.content_whitelist = ["music"]\n`,
    `[processing.filtering]\ncontent_whitelist = [\n`,
  ]) {
    const file = configFile(t, source);
    assert.throws(() => loadConfigToml(file), /config.toml|content_whitelist/);
    assert.equal(readFileSync(file, "utf-8"), source);
    assert.deepEqual(readdirSync(join(file, "..")), ["config.toml"]);
  }
});

test("a symlinked config cannot be rewritten automatically", (t) => {
  const target = configFile(
    t,
    `[processing.filtering]\ncontent_whitelist = ["music"]\n`,
  );
  const link = join(target, "..", "linked.toml");
  symlinkSync(target, link);
  const original = readFileSync(target, "utf-8");
  assert.throws(() => loadConfigToml(link), /symlinks cannot be migrated/);
  assert.equal(readFileSync(target, "utf-8"), original);
});

test("a symlinked config without legacy keys remains readable", (t) => {
  const target = configFile(
    t,
    `[whitelist.video]\ncontent_keywords = ["music"]\n`,
  );
  const link = join(target, "..", "linked.toml");
  symlinkSync(target, link);
  assert.deepEqual(loadConfigToml(link).whitelist, {
    video: { content_keywords: ["music"] },
  });
  assert.equal(readFileSync(target, "utf-8"), readFileSync(link, "utf-8"));
});

test("migration retains numeric-string minute IDs", (t) => {
  const file = configFile(
    t,
    `[minute]\nbootstrap_tid_v2_allowlist = ["2022"]\n`,
  );
  const migrated = loadConfigToml(file);
  assert.deepEqual(migrated.whitelist, {
    minute_bootstrap: { tid_v2: ["2022"] },
  });
  assert.match(readFileSync(file, "utf-8"), /tid_v2 = \["2022"\]/);
});

test("invalid migrated whitelist leaves the original config untouched", (t) => {
  const source = `[processing.filtering]\ncontent_whitelist = ["   "]\n`;
  const file = configFile(t, source);
  assert.throws(() => loadConfigToml(file), /contentKeywords/);
  assert.equal(readFileSync(file, "utf-8"), source);
  assert.deepEqual(readdirSync(join(file, "..")), ["config.toml"]);
});

test("invalid source TOML warns and falls back to environment configuration", (t) => {
  const source = "[processing.filtering\n";
  const file = configFile(t, source);
  assert.throws(() => loadConfigToml(file), ConfigTomlParseError);
  const root = process.cwd();
  const result = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [
      "-e",
      `const { config } = require(${JSON.stringify(join(root, "src/config/index.ts"))}); console.log(config.bilibili.cookieFiles[0].path)`,
    ],
    {
      cwd: dirname(file),
      encoding: "utf-8",
      env: { ...process.env, BILIBILI_COOKIE_FILE: "from-environment" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /config.toml not found or invalid/);
  assert.match(result.stdout, /from-environment/);
  assert.equal(readFileSync(file, "utf-8"), source);
});

test("an existing migration lock leaves the source unchanged", (t) => {
  const source = `[processing.filtering]\ncontent_whitelist = ["music"]\n`;
  const file = configFile(t, source);
  const lock = `${file}.migration-lock`;
  writeFileSync(lock, "", { flag: "wx" });
  assert.throws(() => loadConfigToml(file), /EEXIST/);
  assert.equal(readFileSync(file, "utf-8"), source);
  assert.deepEqual(readdirSync(dirname(file)).sort(), [
    "config.toml",
    "config.toml.migration-lock",
  ]);
});
