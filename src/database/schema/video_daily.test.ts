import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

type RecordedQuery = {
  sql: string;
  values?: unknown[];
};

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

function createPool(
  handleClientQuery: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number }>,
): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return handleClientQuery(sql, values);
    },
    release() {},
  } as unknown as PoolClient;
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return client;
    },
  } as unknown as Pool;
  return { pool, queries };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

test("video_daily initialization validates the canonical unique index before dropping redundant indexes", async () => {
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: [canonicalIndex], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  const createUniqueIndex = queries.findIndex(({ sql }) =>
    sql.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_video_daily_aid_record_date",
    ),
  );
  const validateIndex = queries.findIndex(({ sql }) =>
    sql.includes("FROM pg_index AS index_definition"),
  );
  const dropLegacyIndex = queries.findIndex(({ sql }) =>
    sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
  );
  const commit = queries.findIndex(({ sql }) => sql === "COMMIT");
  const createHypertable = queries.findIndex(({ sql }) =>
    sql.includes("SELECT create_hypertable"),
  );

  assert.ok(createUniqueIndex < validateIndex);
  assert.ok(validateIndex < dropLegacyIndex);
  assert.ok(dropLegacyIndex < commit);
  assert.ok(commit < createHypertable);
});

test("video_daily initialization replaces duplicate dates with deterministic minimum-view rows", async () => {
  const duplicateError = Object.assign(
    new Error("Key (aid, record_date)=(1, 2026-06-03) already exists."),
    { code: "23505" },
  );
  let createAttempts = 0;
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) {
      createAttempts += 1;
      if (createAttempts === 1) throw duplicateError;
    }
    if (sql.includes("SELECT duplicate_keys.record_date::text")) {
      return {
        rows: [{ record_date: "2026-06-03" }],
        rowCount: 1,
      };
    }
    if (sql.includes("timescaledb_information.chunks")) {
      return {
        rows: [{ chunk_name: "_timescaledb_internal._hyper_11_213_chunk" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: [canonicalIndex], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  assert.equal(createAttempts, 2);
  const stage = normalizeSql(
    queries.find(({ sql }) => sql.includes("SELECT DISTINCT ON (aid)"))?.sql ??
      "",
  );
  assert.match(stage, /WHERE record_date = DATE '2026-06-03'/);
  assert.match(
    stage,
    /ORDER BY aid, "view" ASC NULLS LAST, coin ASC NULLS LAST, favorite ASC NULLS LAST, danmaku ASC NULLS LAST, reply ASC NULLS LAST, share ASC NULLS LAST, "like" ASC NULLS LAST/,
  );

  const cleanupDml = queries
    .map(({ sql }) => normalizeSql(sql))
    .filter(
      (sql) =>
        sql.startsWith("DELETE FROM video_daily") ||
        sql.startsWith("INSERT INTO video_daily (") ||
        sql.startsWith("INSERT INTO video_daily_deduplicated"),
    );
  assert.equal(cleanupDml.length, 3);
  for (const sql of cleanupDml) {
    assert.match(sql, /record_date = DATE '2026-06-03'/);
  }

  const commit = queries.findIndex(({ sql }) => sql === "COMMIT");
  const recompress = queries.findIndex(
    ({ sql, values }) =>
      sql === "SELECT recompress_chunk($1::regclass)" &&
      values?.[0] === "_timescaledb_internal._hyper_11_213_chunk",
  );
  assert.ok(commit < recompress);
});

test("video_daily initialization propagates non-duplicate index build errors", async () => {
  const diskError = Object.assign(new Error("No space left on device"), {
    code: "53100",
  });
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) throw diskError;
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(initializeVideoDaily(pool), (error: unknown) => {
    assert.equal(error, diskError);
    return true;
  });
  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("SELECT duplicate_keys.record_date::text"),
    ),
    false,
  );
  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
    ),
    false,
  );
  assert.equal(
    queries.some(({ sql }) => sql === "ROLLBACK"),
    true,
  );
});

test("video_daily initialization rejects a canonical index with the wrong key order", async () => {
  const { pool, queries } = createPool(async (sql) => {
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
  });

  await assert.rejects(
    initializeVideoDaily(pool),
    /must be a valid unique btree index on \(aid, record_date\)/,
  );
  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
    ),
    false,
  );
});
