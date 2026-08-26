import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { config } from "../config";
import { Database } from "./index";

test("normal startup provisions enabled accounts without running schema DDL", async () => {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const originalConnect = Pool.prototype.connect;
  const originalEnd = Pool.prototype.end;
  const originalQuery = Pool.prototype.query;
  const originalCookieFiles = config.bilibili.cookieFiles;
  const database = Database.getInstance();
  const directory = mkdtempSync(join(tmpdir(), "hantang-database-init-"));
  const cookiePath = join(directory, "cookies.txt");
  writeFileSync(
    cookiePath,
    ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsession\n" +
      ".bilibili.com\tTRUE\t/\tTRUE\t0\tDedeUserID\t42\n",
  );
  config.bilibili.cookieFiles = [{ path: cookiePath, enableWatchLater: true }];

  Pool.prototype.connect = (async () => ({ release() {} })) as Pool["connect"];
  Pool.prototype.end = (async () => undefined) as Pool["end"];
  Pool.prototype.query = (async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: [], rowCount: 0 };
  }) as Pool["query"];

  try {
    await database.init("postgres://test:password@localhost/test");
  } finally {
    await database.close();
    Pool.prototype.connect = originalConnect;
    Pool.prototype.end = originalEnd;
    Pool.prototype.query = originalQuery;
    config.bilibili.cookieFiles = originalCookieFiles;
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(queries.length, 1);
  assert.match(
    queries[0]?.sql ?? "",
    /INSERT INTO watch_later_account \(account_id\)/,
  );
  assert.deepEqual(queries[0]?.values, ["42"]);
  assert.equal(
    queries.some(({ sql }) => /\b(?:ALTER|CREATE|DROP)\b/i.test(sql)),
    false,
  );
});
