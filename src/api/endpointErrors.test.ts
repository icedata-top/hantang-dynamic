import assert from "node:assert/strict";
import test from "node:test";
import { metricsRegistry } from "../metrics/registry";
import { EndpointErrorAlerts } from "./endpointErrors";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("alerts above 50% errors in the last 20 final requests, once per endpoint", async () => {
  const messages: string[] = [];
  const alerts = new EndpointErrorAlerts(
    async (message) => {
      messages.push(message);
    },
    () => assert.fail("notification failed"),
  );
  for (let i = 0; i < 30; i++) alerts.record("api.test", "/a", "retry");
  for (let i = 0; i < 10; i++) alerts.record("api.test", "/a", "success");
  for (let i = 0; i < 9; i++) alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 0);
  alerts.record("api.test", "/a", "error");
  await flush();
  assert.equal(messages.length, 0);
  alerts.record("api.test", "/a", "error");
  await flush();
  const exposed = await metricsRegistry.metrics();
  assert.match(
    exposed,
    /api_endpoint_recent_sample_count\{[^\n]*host="api.test",route="\/a"[^\n]*\} 20\n/,
  );
  assert.match(
    exposed,
    /api_endpoint_recent_error_ratio\{[^\n]*host="api.test",route="\/a"[^\n]*\} 0\.55\n/,
  );
  assert.match(
    exposed,
    /api_endpoint_alert_triggered\{[^\n]*host="api.test",route="\/a"[^\n]*\} 1\n/,
  );
  assert.match(messages[0], /api.test\/a\nLast 20 requests: 11\/20.*55%/);
  for (let i = 0; i < 20; i++) {
    alerts.record("api.test", "/a", "error");
    alerts.record("api.test", "/b", "error");
    alerts.record("other.test", "/a", "error");
  }
  await flush();
  assert.equal(messages.length, 3);
  assert.match(messages[1], /api.test\/b/);
  assert.match(messages[2], /other.test\/a/);
  for (let i = 0; i < 20; i++) alerts.record("api.test", "/a", "success");
  await flush();
  assert.equal(messages.length, 3);
  const recovered = await metricsRegistry.metrics();
  assert.match(
    recovered,
    /api_endpoint_recent_sample_count\{[^\n]*host="api.test",route="\/a"[^\n]*\} 20\n/,
  );
  assert.match(
    recovered,
    /api_endpoint_recent_error_ratio\{[^\n]*host="api.test",route="\/a"[^\n]*\} 0\n/,
  );
  assert.match(
    recovered,
    /api_endpoint_alert_triggered\{[^\n]*host="api.test",route="\/a"[^\n]*\} 1\n/,
  );
});

test("notification rejection is handled without repeating the alert", async () => {
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
