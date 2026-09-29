import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCookieFileAccount } from "./account";

function writeCookieFile(contents: string): {
  directory: string;
  path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "hantang-cookie-"));
  const path = join(directory, "cookies.txt");
  writeFileSync(path, contents);
  return { directory, path };
}

test("cookie DedeUserID takes precedence over the single-file uid fallback", () => {
  const cookie = writeCookieFile(
    ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n.bilibili.com\tTRUE\t/\tTRUE\t0\tDedeUserID\t42\n",
  );
  try {
    const account = loadCookieFileAccount(
      {
        path: cookie.path,
        enableWatchLater: true,
      },
      "99",
    );
    assert.equal(account?.uid, "42");
    assert.equal(account?.enableWatchLater, true);
  } finally {
    rmSync(cookie.directory, { recursive: true, force: true });
  }
});

test("multi-file cookie accounts without their own DedeUserID are omitted", () => {
  const cookie = writeCookieFile(
    ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n",
  );
  try {
    assert.equal(
      loadCookieFileAccount({ path: cookie.path, enableWatchLater: true }),
      null,
    );
  } finally {
    rmSync(cookie.directory, { recursive: true, force: true });
  }
});

test("a single cookie file may use the configured numeric uid", () => {
  const cookie = writeCookieFile(
    ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n",
  );
  try {
    const account = loadCookieFileAccount(
      { path: cookie.path, enableWatchLater: false },
      "12345678",
    );
    assert.equal(account?.uid, "12345678");
  } finally {
    rmSync(cookie.directory, { recursive: true, force: true });
  }
});
