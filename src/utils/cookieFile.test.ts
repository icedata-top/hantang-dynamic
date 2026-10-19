import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCookieJarFromNetscape,
  getAllCookiesAsString,
  parseNetscapeCookieFile,
  writeCookieJarToNetscape,
} from "./cookieFile";

const NOW = Math.floor(Date.now() / 1000);

function cookieLine(name: string, value: string, expires = 0): string {
  return `.bilibili.com\tTRUE\t/\tTRUE\t${expires}\t${name}\t${value}\n`;
}

function withCookieFile(contents: string, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "hantang-cookie-"));
  const path = join(directory, "cookies.txt");
  writeFileSync(path, contents);
  try {
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("parseNetscapeCookieFile rejects a SESSDATA whose column expiry has passed", () => {
  withCookieFile(
    cookieLine("SESSDATA", "hash%2C9999999999%2Cmd5", NOW - 60),
    (path) => {
      assert.throws(() => parseNetscapeCookieFile(path), /expired SESSDATA/);
    },
  );
});

test("parseNetscapeCookieFile rejects a SESSDATA whose embedded expiry has passed", () => {
  withCookieFile(cookieLine("SESSDATA", `hash%2C${NOW - 60}%2Cmd5`), (path) => {
    assert.throws(() => parseNetscapeCookieFile(path), /expired SESSDATA/);
  });
});

test("parseNetscapeCookieFile accepts a valid SESSDATA", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600),
    (path) => {
      assert.equal(parseNetscapeCookieFile(path).length, 1);
    },
  );
});

test("createCookieJarFromNetscape skips expired cookies and keeps valid ones", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600) +
      cookieLine("buvid3", "valid", NOW + 3600) +
      cookieLine("b_lsid", "stale", NOW - 60),
    (path) => {
      const jar = createCookieJarFromNetscape(parseNetscapeCookieFile(path));
      const header = getAllCookiesAsString(jar);
      assert.match(header, /SESSDATA=hash/);
      assert.match(header, /buvid3=valid/);
      assert.doesNotMatch(header, /b_lsid=/);
    },
  );
});

test("writeCookieJarToNetscape refuses to overwrite auth cookies missing from the jar", () => {
  const original =
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600) +
    cookieLine("DedeUserID", "42");

  withCookieFile(original, (path) => {
    writeCookieJarToNetscape(createCookieJarFromNetscape([]), path);
    assert.equal(readFileSync(path, "utf-8"), original);
  });
});

test("writeCookieJarToNetscape persists a jar that still has auth cookies", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600) +
      cookieLine("DedeUserID", "42"),
    (path) => {
      const jar = createCookieJarFromNetscape(parseNetscapeCookieFile(path));
      writeCookieJarToNetscape(jar, path);
      const persisted = readFileSync(path, "utf-8");
      assert.match(persisted, /SESSDATA/);
      assert.match(persisted, /DedeUserID/);
    },
  );
});
