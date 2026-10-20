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

test("parseNetscapeCookieFile rejects a SESSDATA whose token expiry has passed", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW - 60}%2Cmd5`, NOW + 3600),
    (path) => {
      assert.throws(() => parseNetscapeCookieFile(path), /expired SESSDATA/);
    },
  );
});

test("parseNetscapeCookieFile rejects an expired token even when the column is a session value", () => {
  withCookieFile(cookieLine("SESSDATA", `hash%2C${NOW - 60}%2Cmd5`), (path) => {
    assert.throws(() => parseNetscapeCookieFile(path), /expired SESSDATA/);
  });
});

test("parseNetscapeCookieFile ignores a stale column when the SESSDATA token is valid", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW - 60),
    (path) => {
      assert.equal(parseNetscapeCookieFile(path).length, 1);
    },
  );
});

test("parseNetscapeCookieFile loads a SESSDATA without a parseable token expiry", () => {
  withCookieFile(cookieLine("SESSDATA", "opaque-token", NOW - 60), (path) => {
    assert.equal(parseNetscapeCookieFile(path).length, 1);
  });
});

test("createCookieJarFromNetscape uses the SESSDATA token expiry over the file column", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW - 60),
    (path) => {
      const jar = createCookieJarFromNetscape(parseNetscapeCookieFile(path));
      assert.match(getAllCookiesAsString(jar), /SESSDATA=hash/);

      const sessdata = jar
        .serializeSync()
        ?.cookies.find((cookie) => cookie.key === "SESSDATA");
      assert.equal(
        new Date(sessdata?.expires as string).getTime(),
        (NOW + 3600) * 1000,
      );
    },
  );
});

test("auth cookies stay session-scoped even when their file expiry is in the future", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600) +
      cookieLine("DedeUserID", "42", NOW + 1) +
      cookieLine("DedeUserID__ckMd5", "abc", NOW + 1) +
      cookieLine("bili_jct", "csrf", NOW + 1),
    (path) => {
      const jar = createCookieJarFromNetscape(parseNetscapeCookieFile(path));
      const serialized = jar.serializeSync()?.cookies ?? [];
      for (const name of ["DedeUserID", "DedeUserID__ckMd5", "bili_jct"]) {
        const cookie = serialized.find((c) => c.key === name);
        assert.ok(cookie, `${name} should be in the jar`);
        assert.equal(
          cookie.expires,
          undefined,
          `${name} must not expire locally`,
        );
      }
    },
  );
});

test("createCookieJarFromNetscape skips expired non-auth cookies but keeps auth cookies", () => {
  withCookieFile(
    cookieLine("SESSDATA", `hash%2C${NOW + 3600}%2Cmd5`, NOW + 3600) +
      cookieLine("buvid3", "stale", NOW - 60) +
      cookieLine("b_lsid", "stale", NOW - 60),
    (path) => {
      const jar = createCookieJarFromNetscape(parseNetscapeCookieFile(path));
      const header = getAllCookiesAsString(jar);
      assert.match(header, /SESSDATA=hash/);
      assert.match(header, /b_lsid=stale/);
      assert.doesNotMatch(header, /buvid3=/);
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

test("writeCookieJarToNetscape persists auth cookies as session cookies", () => {
  withCookieFile("", (path) => {
    const jar = createCookieJarFromNetscape([]);
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    for (const name of ["SESSDATA", "DedeUserID"]) {
      jar.setCookieSync(
        `${name}=value; Domain=bilibili.com; Path=/; Expires=${future}`,
        "https://www.bilibili.com/",
      );
    }
    writeCookieJarToNetscape(jar, path);
    const persisted = readFileSync(path, "utf-8");
    assert.match(persisted, /\t0\tSESSDATA\t/);
    assert.match(persisted, /\t0\tDedeUserID\t/);
  });
});
