import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AxiosAdapter } from "axios";
import { CookieJar } from "tough-cookie";
import { StateManager } from "../core/state";
import {
  createAccountToViewClient,
  isAccountAuthError,
  missingResourceReason,
  type RequestConfig,
} from "./client";

test("logical API errors are logged with redaction before raw rejection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hantang-api-client-"));
  const state = new StateManager(join(directory, "state.json"));
  state.updateTicket("test-ticket", Math.floor(Date.now() / 1000) + 7200);

  const client = createAccountToViewClient(
    new CookieJar(),
    join(directory, "cookies.txt"),
    state,
    "test-account",
  );
  const adapter: AxiosAdapter = async (request) => ({
    config: request,
    data: {
      code: 90001,
      message: "failed SESSDATA=response-secret",
      nested: { token: "response-token" },
    },
    headers: {},
    status: 200,
    statusText: "OK",
  });

  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  const requestConfig = {
    adapter,
    headers: { Authorization: "Bearer request-secret" },
    rawApiErrors: true,
  };

  try {
    await assert.rejects(
      client.post("/add", "csrf=request-secret", requestConfig),
      (error: unknown) => {
        assert.deepEqual(error, {
          message: "API Error: code 90001",
          status: 200,
          code: 90001,
          data: {
            code: 90001,
            message: "failed SESSDATA=response-secret",
            nested: { token: "response-token" },
          },
        });
        return true;
      },
    );
  } finally {
    console.error = originalConsoleError;
    rmSync(directory, { recursive: true, force: true });
  }

  const diagnostic = errors.join("\n");
  assert.match(diagnostic, /Code: 90001/);
  assert.match(diagnostic, /Request: POST/);
  assert.match(diagnostic, /Response:/);
  // Never dump the axios config: it carries the cookie jar, agents, and TLS
  // session cache, which made a single error tens of kilobytes long.
  assert.doesNotMatch(
    diagnostic,
    /Config:|"jar"|withCredentials|httpsAgent|httpAgent/,
  );
  assert.doesNotMatch(
    diagnostic,
    /request-secret|response-secret|response-token/,
  );
  assert.match(diagnostic, /\[redacted\]/);
});

test("caller-handled business codes are not logged as errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hantang-api-expected-"));
  const state = new StateManager(join(directory, "state.json"));
  state.updateTicket("test-ticket", Math.floor(Date.now() / 1000) + 7200);
  const client = createAccountToViewClient(
    new CookieJar(),
    join(directory, "cookies.txt"),
    state,
    "test-account",
  );
  const adapter: AxiosAdapter = async (request) => ({
    config: request,
    data: {
      code: 4101133,
      message: "请求数据发生错误，请刷新或稍后重试",
    },
    headers: {},
    status: 200,
    statusText: "OK",
  });

  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  const requestConfig = {
    adapter,
    rawApiErrors: true,
    metadata: { expectedApiCodes: [4101133] },
  };
  try {
    await assert.rejects(
      client.get("/feed/all", requestConfig),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 4101133);
        return true;
      },
    );
  } finally {
    console.error = originalConsoleError;
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(errors.join("\n"), "");
});

test("raw API mode preserves account authentication and risk-control errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hantang-api-auth-"));
  const state = new StateManager(join(directory, "state.json"));
  state.updateTicket("test-ticket", Math.floor(Date.now() / 1000) + 7200);
  const client = createAccountToViewClient(
    new CookieJar(),
    join(directory, "cookies.txt"),
    state,
    "auth-account",
  );
  try {
    for (const code of [4100000, -352, -101]) {
      const adapter: AxiosAdapter = async (request) => ({
        config: request,
        data: { code, message: "authentication unavailable" },
        headers: {},
        status: 200,
        statusText: "OK",
      });
      await assert.rejects(
        client.post("/add", "csrf=test", {
          adapter,
          rawApiErrors: true,
        } as RequestConfig),
        (error: unknown) => isAccountAuthError(error) && error.code === code,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing dynamic content is recognized across error shapes", () => {
  const message =
    "MISS_MEDIALIST_DATA: dyn_id = 1172192284147449913, rid = 3931291464";

  assert.equal(
    missingResourceReason({
      message: "Request failed with status code 500",
      status: 500,
      code: 500,
      data: { code: 500, message },
    }),
    message,
  );
  assert.equal(
    missingResourceReason({
      message: "Request failed with status code 500",
      response: { status: 500, data: { code: 500, message } },
    }),
    message,
  );
  assert.equal(missingResourceReason({ message }), message);

  // Ordinary failures and other business codes stay retryable/observable.
  assert.equal(
    missingResourceReason({ message: "Request failed with status code 503" }),
    undefined,
  );
  assert.equal(
    missingResourceReason({ message: "MISSING_SOMETHING" }),
    undefined,
  );
  assert.equal(missingResourceReason(null), undefined);
});
