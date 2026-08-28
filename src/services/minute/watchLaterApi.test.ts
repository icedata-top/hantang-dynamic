import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "tough-cookie";
import { AccountAuthError } from "../../api/client";
import { config } from "../../config";
import { watchLaterMutationsTotal } from "../../metrics/registry";
import {
  fetchWatchLaterSnapshot,
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

test("Watch Later mutation applies the minute request timeout", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const context = account(null, []);
    let timeout: number | undefined;
    context.toViewClient.post = async (_url, _body, request) => {
      timeout = request.timeout;
      return { data: { code: 0 } };
    };

    await mutateWatchLater(context, 1n, "add");

    assert.equal(timeout, 120_000);
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

test("Watch Later snapshot uses complete To View validation and preserves metadata", async () => {
  const valid = await fetchWatchLaterSnapshot({
    async get() {
      return {
        data: {
          code: 0,
          data: {
            count: 1,
            list: [
              {
                aid: 1,
                pid_v2: 9,
                stat: {
                  aid: 1,
                  coin: 1,
                  favorite: 2,
                  danmaku: 3,
                  view: 4,
                  reply: 5,
                  share: 6,
                  like: 7,
                },
              },
            ],
          },
        },
      };
    },
  });
  const missing = await fetchWatchLaterSnapshot({
    async get() {
      return { data: { code: 0 } };
    },
  });

  assert.deepEqual(valid?.aids, new Set(["1"]));
  assert.deepEqual(valid?.pidV2Metadata, [{ aid: 1n, pidV2: 9 }]);
  assert.equal(missing, null);
});

test("Watch Later mutation preserves account authentication errors", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    const context = account(null, []);
    const authError = new AccountAuthError(4100000, "7", "expired");
    context.toViewClient.post = async () => Promise.reject(authError);

    await assert.rejects(
      mutateWatchLater(context, 1n, "add"),
      (error: unknown) => error === authError,
    );
  });
});

test("Watch Later mutation metrics count only attempted POST requests", async () => {
  await withGlobalCsrfToken(undefined, async () => {
    watchLaterMutationsTotal.reset();
    await assert.rejects(
      mutateWatchLater(account(null, []), 1n, "add"),
      /requires an authenticated account/,
    );
    assert.deepEqual((await watchLaterMutationsTotal.get()).values, []);
  });

  await withGlobalCsrfToken("global-token", async () => {
    const succeeded = account(null, []);
    await mutateWatchLater(succeeded, 1n, "add");

    const capacityBlocked = account(null, []);
    capacityBlocked.toViewClient.post = async () =>
      Promise.reject({ status: 200, code: 90001 });
    await mutateWatchLater(capacityBlocked, 2n, "add");

    const authFailed = account(null, []);
    const authError = new AccountAuthError(4100000, "7", "expired");
    authFailed.toViewClient.post = async () => Promise.reject(authError);
    await assert.rejects(
      mutateWatchLater(authFailed, 3n, "add"),
      (error: unknown) => error === authError,
    );

    const ambiguous = account(null, []);
    ambiguous.toViewClient.post = async () =>
      Promise.reject(new Error("network failure"));
    await assert.rejects(
      mutateWatchLater(ambiguous, 4n, "add"),
      /network failure/,
    );
  });

  const { values } = await watchLaterMutationsTotal.get();
  assert.deepEqual(
    values.map(({ labels, value }) => ({ labels, value })),
    [
      { labels: { action: "add", outcome: "succeeded" }, value: 1 },
      {
        labels: { action: "add", outcome: "capacity_blocked" },
        value: 1,
      },
      { labels: { action: "add", outcome: "failed" }, value: 1 },
      { labels: { action: "add", outcome: "ambiguous" }, value: 1 },
    ],
  );
  watchLaterMutationsTotal.reset();
});

test("Watch Later mutation treats HTTP failures as ambiguous", async () => {
  await withGlobalCsrfToken("global-token", async () => {
    watchLaterMutationsTotal.reset();
    const context = account(null, []);
    const httpError = { status: 502, code: 502, message: "Bad Gateway" };
    context.toViewClient.post = async () => Promise.reject(httpError);

    await assert.rejects(
      mutateWatchLater(context, 1n, "add"),
      (error: unknown) => error === httpError,
    );

    assert.deepEqual(
      (await watchLaterMutationsTotal.get()).values.map(
        ({ labels, value }) => ({ labels, value }),
      ),
      [{ labels: { action: "add", outcome: "ambiguous" }, value: 1 }],
    );
    watchLaterMutationsTotal.reset();
  });
});
