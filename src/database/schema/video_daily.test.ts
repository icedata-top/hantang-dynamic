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
  let createAttempts = 0;
  let recompressionQueued = false;
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) {
      createAttempts += 1;
    }
    if (sql.includes("WITH date_bounds AS")) {
      return {
        rows: [{ record_date: "2026-06-02" }, { record_date: "2026-06-03" }],
        rowCount: 2,
      };
    }
    if (sql.includes("AS has_duplicates")) {
      return {
        rows: [{ has_duplicates: sql.includes("DATE '2026-06-03'") }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO video_daily_recompression_queue")) {
      recompressionQueued = true;
    }
    if (
      sql.includes("SELECT chunk_schema::text, chunk_name::text") &&
      recompressionQueued
    ) {
      return {
        rows: [
          {
            chunk_name: "_hyper_11_213_chunk",
            chunk_schema: "_timescaledb_internal",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("DELETE FROM video_daily_recompression_queue")) {
      recompressionQueued = false;
    }
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: [canonicalIndex], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  assert.equal(createAttempts, 1);
  const dateEnumeration = normalizeSql(
    queries.find(({ sql }) => sql.includes("WITH date_bounds AS"))?.sql ?? "",
  );
  assert.doesNotMatch(dateEnumeration, /GROUP BY|HAVING/);
  const duplicateChecks = queries.filter(({ sql }) =>
    sql.includes("AS has_duplicates"),
  );
  assert.equal(duplicateChecks.length, 2);
  assert.match(duplicateChecks[0].sql, /record_date = DATE '2026-06-02'/);
  assert.match(duplicateChecks[1].sql, /record_date = DATE '2026-06-03'/);
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
        sql.startsWith("DELETE FROM video_daily WHERE") ||
        sql.startsWith("INSERT INTO video_daily (") ||
        sql.startsWith("INSERT INTO video_daily_deduplicated"),
    );
  assert.equal(cleanupDml.length, 3);
  for (const sql of cleanupDml) {
    assert.match(sql, /record_date = DATE '2026-06-03'/);
  }
  assert.match(
    queries.find(({ sql }) =>
      sql.includes("INSERT INTO video_daily_recompression_queue"),
    )?.sql ?? "",
    /record_date = DATE '2026-06-03'/,
  );

  const commit = queries.findIndex(({ sql }) => sql === "COMMIT");
  const recompress = queries.findIndex(
    ({ sql, values }) =>
      sql === "SELECT recompress_chunk(format('%I.%I', $1, $2)::regclass)" &&
      values?.[0] === "_timescaledb_internal" &&
      values?.[1] === "_hyper_11_213_chunk",
  );
  assert.ok(commit < recompress);
  assert.equal(
    queries.some(({ sql }) =>
      /\b(?:FROM|JOIN)\s+mysql_video_daily\b/i.test(sql),
    ),
    false,
  );
});

test("video_daily initialization retries queued recompression before uniqueness checks", async () => {
  let queued = true;
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("SELECT chunk_schema::text, chunk_name::text") && queued) {
      return {
        rows: [
          {
            chunk_name: "_hyper_11_213_chunk",
            chunk_schema: "_timescaledb_internal",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("DELETE FROM video_daily_recompression_queue")) {
      queued = false;
    }
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: [canonicalIndex], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  const recompress = queries.findIndex(({ sql }) =>
    sql.includes("SELECT recompress_chunk"),
  );
  const uniquenessLock = queries.findIndex(
    ({ sql }) => sql === "LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE",
  );
  assert.ok(recompress < uniquenessLock);
  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("DELETE FROM video_daily_recompression_queue"),
    ),
    true,
  );
});

test("video_daily initialization keeps failed recompression queued", async () => {
  const compressionError = new Error("recompression failed");
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("SELECT chunk_schema::text, chunk_name::text")) {
      return {
        rows: [
          {
            chunk_name: "_hyper_11_213_chunk",
            chunk_schema: "_timescaledb_internal",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT recompress_chunk")) throw compressionError;
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(initializeVideoDaily(pool), (error: unknown) => {
    assert.equal(error, compressionError);
    return true;
  });
  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("DELETE FROM video_daily_recompression_queue"),
    ),
    false,
  );
  assert.equal(
    queries.some(({ sql }) => sql === "ROLLBACK"),
    true,
  );
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
    queries.some(({ sql }) => sql.includes("SELECT DISTINCT ON (aid)")),
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
