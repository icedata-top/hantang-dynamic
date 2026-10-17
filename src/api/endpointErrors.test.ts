import assert from "node:assert/strict";
import test from "node:test";
import { EndpointErrorAlerts } from "./endpointErrors";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("alerts at 20 final requests and 50% errors, independently per endpoint", async () => {
  const messages: string[] = [];
  const alerts = new EndpointErrorAlerts(
    async (message) => {
      messages.push(message);
    },
    () => assert.fail("notification failed"),
  );
  for (let i = 0; i < 30; i++) alerts.record("api.test", "/a", "retry");
  for (let i = 0; i < 9; i++) alerts.record("api.test", "/a", "error");
  for (let i = 0; i < 10; i++) alerts.record("api.test", "/a", "success");
  await flush();
  assert.equal(messages.length, 0);
  alerts.record("api.test", "/a", "success");
  await flush();
  assert.equal(messages.length, 0);
  alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 0);
  alerts.record("api.test", "/a", "error");
  await flush();
  assert.match(messages[0], /api.test\/a\nLast 5 minutes: 11\/22.*50%/);
  for (let i = 0; i < 20; i++) {
    alerts.record("api.test", "/a", "error");
    alerts.record("api.test", "/b", "error");
    alerts.record("other.test", "/a", "error");
  }
  await flush();
  assert.equal(messages.length, 3);
  assert.match(messages[1], /api.test\/b/);
  assert.match(messages[2], /other.test\/a/);
});

test("expires old samples and preserves cooldown after idle periods", async () => {
  let now = 0;
  const messages: string[] = [];
  const alerts = new EndpointErrorAlerts(
    async (message) => {
      messages.push(message);
    },
    () => assert.fail("notification failed"),
    () => now,
  );
  for (let i = 0; i < 19; i++) alerts.record("api.test", "/a", "error");
  now = 5 * 60_000;
  alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 0);
  for (let i = 0; i < 19; i++) alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 1);
  now = 34 * 60_000;
  for (let i = 0; i < 20; i++) alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 1);
  now = 35 * 60_000;
  alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 2);
});

test("notification rejection is handled and still respects cooldown", async () => {
  let attempts = 0;
  let failures = 0;
  const alerts = new EndpointErrorAlerts(
    async () => {
      attempts++;
      throw new Error("delivery unavailable");
    },
    () => {
      failures++;
    },
  );
  for (let i = 0; i < 40; i++) alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(attempts, 1);
  assert.equal(failures, 1);
});
