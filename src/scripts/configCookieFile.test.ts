import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import {
  accountNameFromUname,
  addCookieFileToToml,
  cookieFilePath,
  cookieFilePathsFromToml,
} from "./configCookieFile";

test("cookieFilePath uses the account name", () => {
  assert.equal(cookieFilePath("deironized"), "./.cookies.deironized.txt");
});

test("adds cookie_file when the config has no auth entries", () => {
  const updated = addCookieFileToToml(
    "[application]\nfetch_interval = 1000\n",
    "./.cookies.foo.txt",
  );
  const parsed = parse(updated) as {
    bilibili?: { cookie_file?: string; cookie_files?: unknown[] };
  };
  assert.equal(parsed.bilibili?.cookie_file, "./.cookies.foo.txt");
  assert.match(updated, /\[application\]\nfetch_interval = 1000/);
});

test("converts an existing single cookie_file into cookie_files", () => {
  const updated = addCookieFileToToml(
    '[bilibili]\ncookie_file = "./.cookies.old.txt"\nuid = ""\n',
    "./.cookies.new.txt",
  );
  const parsed = parse(updated) as {
    bilibili?: { cookie_file?: string; cookie_files?: string[] };
  };
  assert.deepEqual(parsed.bilibili?.cookie_files, [
    "./.cookies.old.txt",
    "./.cookies.new.txt",
  ]);
  assert.equal(parsed.bilibili?.cookie_file, "./.cookies.old.txt");
});

test("preserves Watch Later objects when appending", () => {
  const updated = addCookieFileToToml(
    '[bilibili]\ncookie_files = [{ path = "./.cookies.old.txt", enable_watch_later = true }]\n',
    "./.cookies.new.txt",
  );
  const parsed = parse(updated) as {
    bilibili?: {
      cookie_files?: Array<{ path: string; enable_watch_later: boolean }>;
    };
  };
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.bilibili?.cookie_files)), [
    { path: "./.cookies.old.txt", enable_watch_later: true },
    "./.cookies.new.txt",
  ]);
});

test("leaves an already configured path unchanged", () => {
  const content =
    '[bilibili]\ncookie_files = ["./.cookies.foo.txt"]\n# keep me\n';
  assert.equal(addCookieFileToToml(content, "./.cookies.foo.txt"), content);
});

test("ignores cookie_file when cookie_files is present", () => {
  const updated = addCookieFileToToml(
    '[bilibili]\ncookie_file = "./.cookies.ignored.txt"\ncookie_files = ["./.cookies.old.txt"]\n',
    "./.cookies.new.txt",
  );
  const parsed = parse(updated) as {
    bilibili?: { cookie_files?: string[] };
  };
  assert.deepEqual(parsed.bilibili?.cookie_files, [
    "./.cookies.old.txt",
    "./.cookies.new.txt",
  ]);
});

test("derives a safe account name from the profile name", () => {
  assert.equal(accountNameFromUname("极星口服液", "123"), "极星口服液");
  assert.equal(accountNameFromUname("a/b c", "123"), "a_b_c");
  assert.equal(accountNameFromUname("...", "123"), "123");
});

test("lists configured cookie paths", () => {
  assert.deepEqual(
    cookieFilePathsFromToml(
      '[bilibili]\ncookie_files = ["./.cookies.a.txt", "./.cookies.b.txt"]\n',
    ),
    ["./.cookies.a.txt", "./.cookies.b.txt"],
  );
});
