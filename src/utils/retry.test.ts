import assert from "node:assert/strict";
import test from "node:test";
import { retryTransient } from "./retry";

test("retries transient failures and returns the successful result", async () => {
  let attempts = 0;
  const result = await retryTransient(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("timeout exceeded when trying to connect");
      }
      return "ok";
    },
    3,
    0,
    "test",
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("does not retry non-transient failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        attempts++;
        throw new Error("VIDEO_DELETED:BV1test");
      },
      3,
      0,
      "test",
    ),
    /VIDEO_DELETED/,
  );
  assert.equal(attempts, 1);
});
