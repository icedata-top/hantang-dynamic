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
  assert.match(diagnostic, /Response:/);
  assert.doesNotMatch(
    diagnostic,
    /request-secret|response-secret|response-token/,
  );
  assert.match(diagnostic, /\[redacted\]/);
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
    for (const code of [4100000, -352]) {
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
