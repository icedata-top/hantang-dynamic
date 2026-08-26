import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import { config } from "../../config";
import { sendTelegramWarning } from "./telegram";

test("Telegram warnings send arbitrary text within the API limit", async () => {
  const telegram = config.notifications.telegram;
  const originalConfig = { ...telegram };
  const originalAdapter = axios.defaults.adapter;
  let payload: Record<string, unknown> | undefined;

  const adapter: AxiosAdapter = async (request) => {
    payload = JSON.parse(String(request.data));
    return {
      config: request,
      data: { ok: true },
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };

  Object.assign(telegram, {
    enabled: true,
    warningEnabled: true,
    botToken: "test-token",
    chatId: "test-chat",
  });
  axios.defaults.adapter = adapter;

  try {
    await sendTelegramWarning(`<error>&${"😀".repeat(4096)}`);
  } finally {
    Object.assign(telegram, originalConfig);
    axios.defaults.adapter = originalAdapter;
  }

  assert.ok(payload);
  assert.equal("parse_mode" in payload, false);
  assert.equal(Array.from(String(payload.text)).length, 4096);
  assert.match(String(payload.text), /\n\[truncated\]$/);
  assert.match(String(payload.text), /^<error>&/);
});
