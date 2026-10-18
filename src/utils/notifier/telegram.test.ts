import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter, type AxiosRequestConfig } from "axios";
import { config } from "../../config";
import { sendTelegramWarning } from "./telegram";

interface CapturedRequest {
  url: string;
  data: unknown;
}

function captureRequests(handle?: (request: AxiosRequestConfig) => void): {
  requests: CapturedRequest[];
  restore: () => void;
} {
  const telegram = config.notifications.telegram;
  const originalConfig = { ...telegram };
  const originalAdapter = axios.defaults.adapter;
  const requests: CapturedRequest[] = [];

  Object.assign(telegram, {
    enabled: true,
    warningEnabled: true,
    botToken: "test-token",
    chatId: "test-chat",
  });

  const adapter: AxiosAdapter = async (request) => {
    handle?.(request);
    requests.push({ url: request.url ?? "", data: request.data });
    return {
      config: request,
      data: { ok: true },
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };
  axios.defaults.adapter = adapter;

  return {
    requests,
    restore: () => {
      Object.assign(telegram, originalConfig);
      axios.defaults.adapter = originalAdapter;
    },
  };
}

function longDiagnosticMessage(): string {
  const lines = ["API Error:", "Code: 4101133", "Feed page: 37"];
  for (let i = 0; i < 400; i++) {
    lines.push(`line ${i} ${"x".repeat(40)}`);
  }
  lines.push("end of diagnostic");
  return lines.join("\n");
}

test("Telegram warnings send short messages as plain text", async () => {
  const captured = captureRequests();
  const message = "API Error:\nCode: 4101133\nFeed page: 3";

  try {
    await sendTelegramWarning(message);
  } finally {
    captured.restore();
  }

  assert.equal(captured.requests.length, 1);
  assert.match(captured.requests[0].url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(String(captured.requests[0].data)), {
    chat_id: "test-chat",
    text: message,
  });
});

test("Telegram warnings send long messages as a full text file", async () => {
  const captured = captureRequests();
  const message = longDiagnosticMessage();

  try {
    await sendTelegramWarning(message);
  } finally {
    captured.restore();
  }

  assert.equal(captured.requests.length, 1);
  assert.match(captured.requests[0].url, /\/sendDocument$/);

  const form = captured.requests[0].data as FormData;
  assert.equal(form.get("chat_id"), "test-chat");

  const caption = String(form.get("caption"));
  assert.ok(Array.from(caption).length <= 1024);
  assert.match(caption, /^API Error:/);
  assert.match(caption, /\[full message attached as a text file\]$/);

  const document = form.get("document");
  assert.ok(document instanceof Blob);
  assert.equal(await document.text(), message);
});

test("Telegram warnings split untruncated messages when the file upload fails", async () => {
  const captured = captureRequests((request) => {
    if (request.url?.endsWith("/sendDocument")) {
      throw new Error("upload failed");
    }
  });
  const message = longDiagnosticMessage();

  try {
    await sendTelegramWarning(message);
  } finally {
    captured.restore();
  }

  assert.ok(captured.requests.length > 1);
  const texts = captured.requests.map(
    (request) => JSON.parse(String(request.data)).text as string,
  );

  for (const request of captured.requests) {
    assert.match(request.url, /\/sendMessage$/);
  }
  for (const text of texts) {
    assert.ok(Array.from(text).length <= 4096);
    assert.doesNotMatch(text, /\[truncated\]/);
  }
  assert.equal(texts.join("\n"), message);
  assert.match(texts[texts.length - 1] ?? "", /end of diagnostic$/);
});
