import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { Database } from "./index";

test("normal startup upgrades the due-video function after adding Watch Later state", async () => {
  const queries: string[] = [];
  const originalConnect = Pool.prototype.connect;
  const originalEnd = Pool.prototype.end;
  const originalQuery = Pool.prototype.query;
  const database = Database.getInstance();

  Pool.prototype.connect = (async () => ({ release() {} })) as Pool["connect"];
  Pool.prototype.end = (async () => undefined) as Pool["end"];
  Pool.prototype.query = (async (query: string) => {
    queries.push(query);
    return { rows: [], rowCount: 0 };
  }) as Pool["query"];

  try {
    await database.init("postgres://test:password@localhost/test");
  } finally {
    await database.close();
    Pool.prototype.connect = originalConnect;
    Pool.prototype.end = originalEnd;
    Pool.prototype.query = originalQuery;
  }

  const addColumn = queries.findIndex((sql) =>
    sql.includes("ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids"),
  );
  const dropFunction = queries.findIndex((sql) =>
    sql.includes("DROP FUNCTION IF EXISTS fn_select_due_minute_videos"),
  );
  const createFunction = queries.findIndex((sql) =>
    sql.includes("CREATE OR REPLACE FUNCTION fn_select_due_minute_videos"),
  );

  assert.ok(addColumn >= 0);
  assert.ok(dropFunction > addColumn);
  assert.ok(createFunction > dropFunction);
  assert.equal(
    queries.filter((sql) =>
      sql.includes("DROP FUNCTION IF EXISTS fn_select_due_minute_videos"),
    ).length,
    1,
  );
  assert.equal(
    queries.filter((sql) =>
      sql.includes("CREATE OR REPLACE FUNCTION fn_select_due_minute_videos"),
    ).length,
    1,
  );
});
