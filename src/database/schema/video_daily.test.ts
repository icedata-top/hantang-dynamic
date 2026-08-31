import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

async function initializeVideoDaily(pool: Pool): Promise<void> {
  process.env.SESSDATA ??= "test";
  process.env.BILIBILI_UID ??= "1";
  const { initVideoDailySchema } = await import("./video_daily");
  await initVideoDailySchema(pool);
}

const canonicalIndex = {
  index_definition:
    "CREATE UNIQUE INDEX uq_video_daily_aid_record_date ON hantang_dynamic.video_daily USING btree (aid, record_date)",
  is_full_table: true,
  is_unique: true,
  is_valid: true,
  key_columns: ["aid", "record_date"],
};

test("video_daily initialization creates and validates the canonical unique index before dropping duplicates", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM pg_index AS index_definition")) {
        return { rows: [canonicalIndex], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await initializeVideoDaily(pool);

  const createTable = queries.findIndex((sql) => sql.includes("CREATE TABLE"));
  const createUniqueIndex = queries.findIndex((sql) =>
    sql.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_video_daily_aid_record_date",
    ),
  );
  const validateIndex = queries.findIndex((sql) =>
    sql.includes("FROM pg_index AS index_definition"),
  );
  const dropLegacyIndex = queries.findIndex((sql) =>
    sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
  );
  const dropDuplicateIndex = queries.findIndex((sql) =>
    sql.includes("DROP INDEX IF EXISTS video_daily_new_aid_record_date_idx"),
  );
  const createHypertable = queries.findIndex((sql) =>
    sql.includes("SELECT create_hypertable"),
  );

  assert.ok(createTable < createUniqueIndex);
  assert.ok(createUniqueIndex < validateIndex);
  assert.ok(validateIndex < dropLegacyIndex);
  assert.ok(dropLegacyIndex < dropDuplicateIndex);
  assert.ok(dropDuplicateIndex < createHypertable);
});

test("video_daily initialization preserves duplicate-key errors from the unique index build", async () => {
  const duplicateError = Object.assign(
    new Error("Key (aid, record_date)=(1, 2026-06-03) already exists."),
    {
      code: "23505",
      detail: "Key (aid, record_date)=(1, 2026-06-03) already exists.",
    },
  );
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) {
        throw duplicateError;
      }
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await assert.rejects(initializeVideoDaily(pool), (error: unknown) => {
    assert.equal(error, duplicateError);
    return true;
  });
  assert.equal(
    queries.some((sql) =>
      sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
    ),
    false,
  );
});

test("video_daily initialization rejects a canonical index with the wrong key order", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM pg_index AS index_definition")) {
        return {
          rows: [
            {
              ...canonicalIndex,
              index_definition:
                "CREATE UNIQUE INDEX uq_video_daily_aid_record_date ON hantang_dynamic.video_daily USING btree (record_date, aid)",
              key_columns: ["record_date", "aid"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as Pool;

  await assert.rejects(
    initializeVideoDaily(pool),
    /must be a valid unique btree index on \(aid, record_date\)/,
  );
  assert.equal(
    queries.some((sql) =>
      sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
    ),
    false,
  );
});
