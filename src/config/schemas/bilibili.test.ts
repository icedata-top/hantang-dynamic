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

test("watch-later sampling accounts default to disabled capacity", () => {
  const configuration = createBilibiliConfig((tomlPath) => {
    return tomlPath.join(".") === "bilibili.watch_later_accounts"
      ? [{ account_id: "123", target_count: 20 }]
      : undefined;
  });

  assert.deepEqual(configuration.watchLaterAccounts, [
    {
      accountId: "123",
      capacity: 0,
      targetCount: 20,
      remoteCapacity: undefined,
    },
  ]);
});
