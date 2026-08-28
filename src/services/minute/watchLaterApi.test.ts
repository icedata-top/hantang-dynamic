import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import { config } from "../../config";
import {
  mutateWatchLater,
  type WatchLaterAccountContext,
} from "./watchLaterApi";

function account(
  cookieJar: CookieJar | null,
  postedTokens: Array<string | null>,
): WatchLaterAccountContext {
  return {
    uid: "7",
    cookieJar,
    toViewClient: {
      async get() {
        return { data: { code: 0, data: { count: 0, list: [] } } };
      },
      async post(_url, body) {
        postedTokens.push(body.get("csrf"));
        return { data: { code: 0 } };
      },
    },
  };
}

async function withGlobalCsrfToken(
  token: string | undefined,
  callback: () => Promise<void>,
): Promise<void> {
  const original = config.bilibili.csrfToken;
  config.bilibili.csrfToken = token;
  try {
    await callback();
  } finally {
    config.bilibili.csrfToken = original;
  }
}

test("Watch Later mutation uses the selected cookie account CSRF token", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const cookieJar = new CookieJar();
    cookieJar.setCookieSync(
      "bili_jct=account-token",
      "https://www.bilibili.com/",
    );
    const postedTokens: Array<string | null> = [];

    await mutateWatchLater(account(cookieJar, postedTokens), 1n, "add");

    assert.deepEqual(postedTokens, ["account-token"]);
  });
});

test("Watch Later mutation uses the global CSRF token for a legacy account", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const postedTokens: Array<string | null> = [];

    await mutateWatchLater(account(null, postedTokens), 1n, "add");

    assert.deepEqual(postedTokens, ["global-token"]);
  });
});

test("Watch Later mutation rejects a cookie account missing bili_jct", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const postedTokens: Array<string | null> = [];

    await assert.rejects(
      mutateWatchLater(account(new CookieJar(), postedTokens), 1n, "add"),
      /Watch-later account is missing bili_jct/,
    );
    assert.deepEqual(postedTokens, []);
  });
});

test("Watch Later mutation returns a structured raw API business code", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const context = account(null, []);
    context.toViewClient.post = async () =>
      Promise.reject({
        message: "API Error: code 90001",
        status: 200,
        code: 90001,
        data: { code: 90001 },
      });

    assert.equal(await mutateWatchLater(context, 1n, "add"), 90001);
  });
});
