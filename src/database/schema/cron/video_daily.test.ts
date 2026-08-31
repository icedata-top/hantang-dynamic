import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

test("daily sync targets one fixed-date TimescaleDB chunk", async () => {
  process.env.SESSDATA ??= "test";
  process.env.BILIBILI_UID ??= "1";

  const { initCronVideoDaily } = await import("./video_daily");
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initCronVideoDaily(pool, "hantang_dynamic");

  const procedureSql = queries[0] ?? "";
  const updateSql = procedureSql.match(
    /EXECUTE \$sync_update\$([\s\S]*?)\$sync_update\$ USING v_record_date;/,
  )?.[1];
  const insertSql = procedureSql.match(
    /EXECUTE \$sync_insert\$([\s\S]*?)\$sync_insert\$ USING v_record_date;/,
  )?.[1];

  assert.ok(updateSql);
  assert.match(updateSql, /UPDATE "hantang_dynamic"\.video_daily AS target/);
  assert.match(updateSql, /WHERE target\.record_date = \$1/);
  assert.ok(insertSql);
  assert.match(insertSql, /NOT EXISTS/);
  assert.match(insertSql, /WHERE target\.record_date = \$1/);
});
