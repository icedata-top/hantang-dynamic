import assert from "node:assert/strict";
import test from "node:test";
import { bilibiliSchema, createBilibiliConfig } from "./bilibili";

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

test("normalized cookie entries pass final configuration validation", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.cookie_files"
      ? [{ path: "./account.txt", enable_watch_later: true }]
      : undefined;
  });

  assert.deepEqual(bilibiliSchema.parse(configuration), configuration);
});

test("cookie file entries reject camelCase and stale account-policy fields", () => {
  const invalidEntries = [
    { path: "./account.txt", enableWatchLater: true },
    { path: "./account.txt", capacity: 1 },
    { path: "./account.txt", target_count: 1 },
    { path: "./account.txt", remote_capacity: 1 },
    { path: "./account.txt", account_id: "123" },
  ];

  for (const entry of invalidEntries) {
    assert.throws(() =>
      createBilibiliConfig((tomlPath) => {
        return tomlPath.join(".") === "bilibili.cookie_files"
          ? [entry]
          : undefined;
      }),
    );
  }
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

test("TOML cookie file string arrays remain authentication-only entries", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.cookie_files"
      ? ["./account.txt"]
      : undefined;
  });

  assert.deepEqual(configuration.cookieFiles, [
    { path: "./account.txt", enableWatchLater: false },
  ]);
});
