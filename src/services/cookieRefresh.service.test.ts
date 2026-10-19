import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCorrespondPath,
  extractRefreshCsrf,
} from "./cookieRefresh.service";

test("correspondPath is a 256-character RSA-OAEP hex value", () => {
  const path = buildCorrespondPath(1_700_000_000_000);
  assert.match(path, /^[0-9a-f]{256}$/);
});

test("refresh csrf is read from the correspond page", () => {
  assert.equal(
    extractRefreshCsrf('<html><div id="1-name">abc123</div></html>'),
    "abc123",
  );
  assert.equal(extractRefreshCsrf("<html>no marker</html>"), null);
});
