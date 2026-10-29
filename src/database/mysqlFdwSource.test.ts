import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { resolveVideoDailySource } from "./mysqlFdwSource";

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, ["hantang_dynamic"]);
      return {
        rows: [
          {
            fdw: "mysql_fdw",
            server_encoding: "UTF8",
            database_name: "hantang_dynamic",
            table_name: "mysql_video_daily",
            server_options: { host: "source-host", port: "3307" },
            table_options: {
              dbname: "archive`db",
              table_name: "daily`history",
            },
            mapping_options: {
              username: "mapped-user",
              password: "mapped-password",
            },
            ...overrides,
          },
        ],
      };
    },
  } as unknown as PoolClient;
}

test("source connection and quoted relation come from the existing foreign table mapping", async () => {
  const source = await resolveVideoDailySource(catalog(), "hantang_dynamic");
  assert.equal(source.table, "`archive``db`.`daily``history`");
  assert.deepEqual(source.connection, {
    host: "source-host",
    port: 3307,
    user: "mapped-user",
    password: "mapped-password",
    database: "archive`db",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  const encodingSource = await resolveVideoDailySource(
    catalog({ server_options: { character_set: "PGDatabaseEncoding" } }),
    "hantang_dynamic",
  );
  assert.equal(encodingSource.connection.charset, "UTF8");
});

test("hidden mapping credentials stop setup before any MySQL connection or deletion", async () => {
  await assert.rejects(
    resolveVideoDailySource(
      catalog({ mapping_options: null }),
      "hantang_dynamic",
    ),
    /current PostgreSQL role cannot read/,
  );
});

test("server-local connection settings cannot silently change the MySQL source", async () => {
  for (const server_options of [
    { mysql_default_file: "/server-only/my.cnf" },
    { ssl_ca: "/server-only/ca.pem" },
  ]) {
    await assert.rejects(
      resolveVideoDailySource(catalog({ server_options }), "hantang_dynamic"),
      /server-local connection files or TLS options/,
    );
  }
});
