import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

test("daily sync inserts missing keys only, one fixed-date TimescaleDB chunk at a time", async () => {
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

  const procedureSql = queries[1] ?? "";
  assert.match(
    procedureSql,
    /IF p_batch_size IS NOT NULL AND p_batch_size < 1 THEN[\s\S]*?batch size must be positive/,
  );
  assert.doesNotMatch(procedureSql, /p_batch_size > 50000/);
  assert.match(procedureSql, /p_batch_size integer DEFAULT NULL/);
  assert.match(procedureSql, /LIMIT p_batch_size/);
  assert.match(
    procedureSql.replace(/\s+/g, " "),
    /SELECT DISTINCT ON \(source\.aid\) source\.record_date, source\.aid, source\.coin, source\.favorite, source\.danmaku, source\."view", source\.reply, source\.share, source\."like" FROM "hantang_dynamic"\.mysql_video_daily AS source WHERE source\.record_date = v_record_date ORDER BY source\.aid, source\."view" ASC NULLS LAST, source\.coin ASC NULLS LAST, source\.favorite ASC NULLS LAST, source\.danmaku ASC NULLS LAST, source\.reply ASC NULLS LAST, source\.share ASC NULLS LAST, source\."like" ASC NULLS LAST/,
  );
  assert.match(
    queries[3] ?? "",
    /sync_video_daily_from_mysql\([\s\S]*?50000,\s*false\s*\)/,
  );
  const insertSql = procedureSql.match(
    /EXECUTE \$sync_insert\$([\s\S]*?)\$sync_insert\$ USING v_record_date;/,
  )?.[1];

  assert.match(procedureSql, /p_prune boolean DEFAULT false/);
  assert.match(
    procedureSql,
    /count\(\*\) INTO v_final_rows[\s\S]*?IF v_final_rows = v_snapshot_rows THEN\s+TRUNCATE "hantang_dynamic"\.mysql_video_daily;/,
  );
  assert.match(queries[0] ?? "", /DROP PROCEDURE/);
  assert.doesNotMatch(procedureSql, /UPDATE "hantang_dynamic"\.video_daily/);
  assert.doesNotMatch(procedureSql, /sync_update|v_updated_rows/);
  assert.ok(insertSql);
  assert.match(insertSql, /NOT EXISTS/);
  assert.match(insertSql, /WHERE target\.record_date = \$1/);
});
