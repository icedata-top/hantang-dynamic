import assert from "node:assert/strict";
import test from "node:test";
import { redactForLog } from "./redact";

test("redaction keeps cookie file names readable", () => {
  const message =
    "Cookie file .cookies_507256226.txt contains an expired SESSDATA. " +
    "Log in again and re-export the cookies.";

  assert.equal(redactForLog(message), message);
});

test("redaction still hides cookie values", () => {
  const redacted = redactForLog("SESSDATA=secret; bili_jct=csrf-secret");

  assert.equal(redacted, "SESSDATA=[redacted]; bili_jct=[redacted]");
  assert.doesNotMatch(redacted, /secret/);
});

test("redaction hides Cookie and Authorization header values", () => {
  assert.equal(
    redactForLog("Cookie: buvid3=abc; SESSDATA=def"),
    "Cookie=[redacted]",
  );
  assert.equal(
    redactForLog("Authorization: Bearer request-secret"),
    "Authorization=[redacted]",
  );
});
