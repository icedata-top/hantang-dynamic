import assert from "node:assert/strict";
import test from "node:test";
import { createBilibiliConfig } from "./bilibili";

test("watch-later empirical account is configured explicitly", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.watch_later_test_account_id"
      ? "123"
      : undefined;
  });

  assert.equal(configuration.watchLaterTestAccountId, "123");
});

test("cookie file entries default watch-later sampling to disabled", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.cookie_files"
      ? [{ path: "./account.txt" }]
      : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    {
      path: "./account.txt",
      enableWatchLater: false,
    },
  ]);
});

test("cookie file entries preserve watch-later enablement", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.cookie_files"
      ? [{ path: "./account.txt", enable_watch_later: true }]
      : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    { path: "./account.txt", enableWatchLater: true },
  ]);
});

test("environment cookie paths are authentication-only entries", () => {
  const configuration = createBilibiliConfig((_tomlPath, envKey) => {
    return envKey === "BILIBILI_COOKIE_FILES" ? "one.txt, two.txt" : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    { path: "one.txt", enableWatchLater: false },
    { path: "two.txt", enableWatchLater: false },
  ]);
});

test("single environment cookie paths are authentication-only entries", () => {
  const configuration = createBilibiliConfig((_tomlPath, envKey) => {
    return envKey === "BILIBILI_COOKIE_FILE" ? "one.txt" : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    { path: "one.txt", enableWatchLater: false },
  ]);
});

test("single TOML cookie paths are authentication-only entries", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.cookie_file"
      ? "one.txt"
      : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    { path: "one.txt", enableWatchLater: false },
  ]);
});

test("TOML cookie file string arrays are rejected", () => {
  assert.throws(() =>
    createBilibiliConfig((tomlPath) => {
      return tomlPath.join(".") === "bilibili.cookie_files"
        ? ["./account.txt"]
        : undefined;
    }),
  );
});
