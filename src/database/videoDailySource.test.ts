import assert from "node:assert/strict";
import test, { mock } from "node:test";
import mysql, { type ConnectionOptions } from "mysql2/promise";
import type { PoolClient } from "pg";
import { videoDailySource } from "./videoDailySource";

const metadata = {
  local_schema: "local",
  local_table: "mysql_video_daily",
  fdw: "mysql_fdw",
  server_options: ["host=192.0.2.1", "port=3307"],
  table_options: ["dbname=remote`db", "table_name=remote`table"],
  mapping_id: 1,
  mapping_options: ["username=fake-user", "password=fake=password"],
};
const pg = (row: object) =>
  ({ query: async () => ({ rows: [row] }) }) as unknown as PoolClient;

test("native deletion uses mapped identifiers, credentials and session settings with bound dates", async () => {
  const statements: [string, unknown[] | undefined][] = [];
  let committed = false;
  const connect = mock.method(
    mysql,
    "createConnection",
    async (options: ConnectionOptions) => {
      assert.deepEqual(options, {
        host: "192.0.2.1",
        port: 3307,
        user: "fake-user",
        password: "fake=password",
        database: "remote`db",
        charset: "utf8mb4",
      });
      return {
        async query(sql: string) {
          statements.push([sql, undefined]);
        },
        async execute(sql: string, values: unknown[]) {
          statements.push([sql, values]);
          return [{ affectedRows: 42 }];
        },
        async commit() {
          committed = true;
        },
        async end() {},
      };
    },
  );
  const source = await videoDailySource(
    pg({
      ...metadata,
      server_options: [
        ...metadata.server_options,
        "character_set=utf8mb4",
        "sql_mode=ANSI_QUOTES,NO_BACKSLASH_ESCAPES",
        "init_command=SET @example = 1",
      ],
    }),
    "local",
  );
  try {
    assert.equal(
      await source.deleteDates(["2026-04-15", "2026-04-17"], "2026-04-18"),
      42,
    );
    assert.ok(committed);
    assert.deepEqual(statements, [
      ["SET @example = 1", undefined],
      ["SET SESSION sql_mode = ?", ["ANSI_QUOTES,NO_BACKSLASH_ESCAPES"]],
      [
        "DELETE FROM `remote``db`.`remote``table` WHERE record_date IN (?,?) AND record_date < ?",
        ["2026-04-15", "2026-04-17", "2026-04-18"],
      ],
    ]);
  } finally {
    await source.close();
    connect.mock.restore();
  }
});

test("FDW automatic charset uses the native driver's default", async () => {
  const connect = mock.method(
    mysql,
    "createConnection",
    async (options: ConnectionOptions) => {
      assert.equal(options.charset, undefined);
      return {
        async execute() {
          return [{ affectedRows: 1 }];
        },
        async commit() {},
        async end() {},
      };
    },
  );
  const source = await videoDailySource(
    pg({
      ...metadata,
      server_options: [...metadata.server_options, "character_set=auto"],
    }),
    "local",
  );
  try {
    assert.equal(await source.deleteDates(["2026-04-15"], "2026-04-18"), 1);
  } finally {
    await source.close();
    connect.mock.restore();
  }
});

test("inaccessible mapping credentials fail before connection with a privilege hint", async () => {
  const connect = mock.method(mysql, "createConnection", () => {
    throw new Error("must not connect");
  });
  try {
    await assert.rejects(
      videoDailySource(pg({ ...metadata, mapping_options: null }), "local"),
      /hidden by pg_user_mappings:.*USAGE.*PUBLIC.*ownership or superuser/,
    );
    assert.equal(connect.mock.calls.length, 0);
  } finally {
    connect.mock.restore();
  }
});

test("server-local connection files fail without exposing their values", async () => {
  for (const option of ["mysql_default_file", "ssl_ca"]) {
    await assert.rejects(
      videoDailySource(
        pg({ ...metadata, server_options: [`${option}=/fake/private-path`] }),
        "local",
      ),
      (error: Error) => {
        assert.equal(
          error.message,
          `Native source cleanup cannot reuse FDW option ${option}`,
        );
        return true;
      },
    );
  }
});
