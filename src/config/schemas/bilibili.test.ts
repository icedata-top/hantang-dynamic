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
