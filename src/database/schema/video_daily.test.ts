import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

type RecordedQuery = { sql: string; values?: unknown[] };
type QueryResult = { rows: unknown[]; rowCount: number };

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
  handleClientQuery: (sql: string, values?: unknown[]) => Promise<QueryResult>,
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

function isDuplicateScan(sql: string): boolean {
  return (
    sql.includes("INSERT INTO video_daily_duplicate_queue") &&
    sql.includes("GROUP BY aid, record_date")
  );
}

test("video_daily initialization uses the canonical-index fast path", async () => {
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: [canonicalIndex], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await initializeVideoDaily(pool);

  const validateIndex = queries.findIndex(({ sql }) =>
    sql.includes("FROM pg_index AS index_definition"),
  );
  const dropLegacyIndex = queries.findIndex(({ sql }) =>
    sql.includes("DROP INDEX IF EXISTS idx_video_daily_aid_date"),
  );
  assert.ok(validateIndex < dropLegacyIndex);
  assert.equal(
    queries.some(({ sql }) => sql.includes("video_daily_duplicate_queue")),
    false,
  );
  assert.equal(
    queries.some(
      ({ sql }) => sql === "LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE",
    ),
    false,
  );
});

test("duplicate queue primary key supports the raw date-first dequeue", async () => {
  let indexExists = false;
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return {
        rows: indexExists ? [canonicalIndex] : [],
        rowCount: indexExists ? 1 : 0,
      };
    }
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) indexExists = true;
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  const queueDefinition = normalizeSql(
    queries.find(({ sql }) =>
      sql.includes(
        "CREATE TEMP TABLE IF NOT EXISTS video_daily_duplicate_queue",
      ),
    )?.sql ?? "",
  );
  assert.match(queueDefinition, /PRIMARY KEY \(record_date, aid\)/);

  const dequeue = normalizeSql(
    queries.find(
      ({ sql }) =>
        sql.includes("FROM video_daily_duplicate_queue AS duplicate_queue") &&
        sql.includes("LIMIT 1"),
    )?.sql ?? "",
  );
  assert.match(
    dequeue,
    /ORDER BY duplicate_queue\.record_date, duplicate_queue\.aid LIMIT 1$/,
  );
});

test("video_daily initialization repairs only queued keys in separate transactions", async () => {
  const queue: Array<{ aid: string; record_date: string }> = [];
  const duplicates = new Set(["11/2026-06-02", "22/2026-06-03"]);
  let indexExists = false;
  const { pool, queries } = createPool(async (sql, values) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return {
        rows: indexExists ? [canonicalIndex] : [],
        rowCount: indexExists ? 1 : 0,
      };
    }
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) indexExists = true;
    if (sql === "TRUNCATE video_daily_duplicate_queue") queue.length = 0;
    if (isDuplicateScan(sql)) {
      for (const duplicate of duplicates) {
        const [aid, record_date] = duplicate.split("/");
        if (
          !queue.some(
            (key) => key.aid === aid && key.record_date === record_date,
          )
        ) {
          queue.push({ aid, record_date });
        }
      }
    }
    if (
      sql.includes("FROM video_daily_duplicate_queue") &&
      sql.includes("LIMIT 1")
    ) {
      return { rows: queue.slice(0, 1), rowCount: Math.min(queue.length, 1) };
    }
    if (sql.includes("count(*) OVER () AS multiplicity")) {
      return {
        rows: [
          {
            aid: values?.[0],
            record_date: values?.[1],
            coin: 2,
            favorite: 3,
            danmaku: 4,
            view: 1,
            reply: 5,
            share: 6,
            like: 7,
            multiplicity: "2",
          },
        ],
        rowCount: 1,
      };
    }
    if (normalizeSql(sql).startsWith("DELETE FROM video_daily WHERE")) {
      duplicates.delete(`${values?.[0]}/${values?.[1]}`);
    }
    if (
      normalizeSql(sql).startsWith("DELETE FROM video_daily_duplicate_queue")
    ) {
      const index = queue.findIndex(
        (key) => key.aid === values?.[0] && key.record_date === values?.[1],
      );
      if (index >= 0) queue.splice(index, 1);
    }
    return { rows: [], rowCount: 0 };
  });

  await initializeVideoDaily(pool);

  const canonicalRead = normalizeSql(
    queries.find(({ sql }) => sql.includes("count(*) OVER () AS multiplicity"))
      ?.sql ?? "",
  );
  assert.match(
    canonicalRead,
    /WHERE aid = \$1 AND record_date = \$2 ORDER BY "view" ASC NULLS LAST, coin ASC NULLS LAST, favorite ASC NULLS LAST, danmaku ASC NULLS LAST, reply ASC NULLS LAST, share ASC NULLS LAST, "like" ASC NULLS LAST LIMIT 1/,
  );
  const deletes = queries.filter(({ sql }) =>
    normalizeSql(sql).startsWith("DELETE FROM video_daily WHERE"),
  );
  assert.deepEqual(
    deletes.map(({ values }) => values),
    [
      ["11", "2026-06-02"],
      ["22", "2026-06-03"],
    ],
  );
  for (const { sql } of deletes) {
    assert.match(normalizeSql(sql), /WHERE aid = \$1 AND record_date = \$2$/);
    assert.doesNotMatch(sql, /DELETE FROM video_daily\s+WHERE record_date =/);
  }
  assert.equal(queries.filter(({ sql }) => sql === "BEGIN").length, 3);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 3);
  assert.equal(
    queries.filter(
      ({ sql }) => sql === "LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE",
    ).length,
    3,
  );
  assert.equal(queries.filter(({ sql }) => isDuplicateScan(sql)).length, 2);
  const finalScan = queries
    .map(({ sql }) => isDuplicateScan(sql))
    .lastIndexOf(true);
  const createIndex = queries.findIndex(({ sql }) =>
    sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS"),
  );
  assert.ok(finalScan < createIndex);

  const allSql = queries.map(({ sql }) => sql).join("\n");
  assert.doesNotMatch(allSql, /max_tuples_decompressed_per_dml_transaction/);
  assert.doesNotMatch(
    allSql,
    /recompress_chunk|timescaledb_information\.chunks/,
  );
  assert.doesNotMatch(allSql, /video_daily_recompression_queue/);
  assert.doesNotMatch(
    allSql,
    /CREATE TABLE IF NOT EXISTS video_daily_duplicate_queue/,
  );
  assert.match(
    allSql,
    /CREATE TEMP TABLE IF NOT EXISTS video_daily_duplicate_queue/,
  );
});

test("plain PostgreSQL reaches uniqueness enforcement without extension SQL", async () => {
  let indexExists = false;
  const { pool, queries } = createPool(async (sql) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return {
        rows: indexExists ? [canonicalIndex] : [],
        rowCount: indexExists ? 1 : 0,
      };
    }
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) indexExists = true;
    return { rows: [], rowCount: 0 };
  });
  await initializeVideoDaily(pool);

  assert.equal(
    queries.some(({ sql }) =>
      sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS"),
    ),
    true,
  );
  const uniquenessSql = queries
    .slice(
      queries.findIndex(({ sql }) =>
        sql.includes("FROM pg_index AS index_definition"),
      ),
      queries.findIndex(({ sql }) => sql.includes("SELECT create_hypertable")),
    )
    .map(({ sql }) => sql)
    .join("\n");
  assert.doesNotMatch(
    uniquenessSql,
    /timescaledb|pg_extension|recompress|_timescaledb|chunks/i,
  );
});

test("a locked final rescan queues concurrent duplicates before index creation", async () => {
  const queue: Array<{ aid: string; record_date: string }> = [];
  let scanCount = 0;
  let indexExists = false;
  let duplicateExists = false;
  const { pool, queries } = createPool(async (sql, values) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: indexExists ? [canonicalIndex] : [], rowCount: 0 };
    }
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) indexExists = true;
    if (isDuplicateScan(sql)) {
      scanCount += 1;
      if (scanCount === 2) duplicateExists = true;
      if (duplicateExists && queue.length === 0) {
        queue.push({ aid: "33", record_date: "2026-06-04" });
      }
    }
    if (
      sql.includes("FROM video_daily_duplicate_queue") &&
      sql.includes("LIMIT 1")
    ) {
      return { rows: queue.slice(0, 1), rowCount: queue.length ? 1 : 0 };
    }
    if (sql.includes("count(*) OVER () AS multiplicity")) {
      return {
        rows: [
          {
            aid: values?.[0],
            record_date: values?.[1],
            coin: 1,
            favorite: 1,
            danmaku: 1,
            view: 1,
            reply: 1,
            share: 1,
            like: 1,
            multiplicity: 2,
          },
        ],
        rowCount: 1,
      };
    }
    if (normalizeSql(sql).startsWith("DELETE FROM video_daily WHERE")) {
      duplicateExists = false;
    }
    if (
      normalizeSql(sql).startsWith("DELETE FROM video_daily_duplicate_queue")
    ) {
      queue.length = 0;
    }
    return { rows: [], rowCount: 0 };
  });
  await initializeVideoDaily(pool);

  assert.equal(scanCount, 3);
  assert.equal(queries.filter(({ sql }) => sql === "BEGIN").length, 3);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 3);
  const createIndex = queries.findIndex(({ sql }) =>
    sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS"),
  );
  assert.equal(
    queries.slice(0, createIndex).filter(({ sql }) => isDuplicateScan(sql))
      .length,
    3,
  );
});

test("a failed later key preserves prior commits and is repaired on rerun", async () => {
  const duplicates = new Set(["11/2026-06-02", "22/2026-06-03"]);
  const queue: Array<{ aid: string; record_date: string }> = [];
  let failSecondKey = true;
  let indexExists = false;
  const { pool, queries } = createPool(async (sql, values) => {
    if (sql.includes("FROM pg_index AS index_definition")) {
      return { rows: indexExists ? [canonicalIndex] : [], rowCount: 0 };
    }
    if (sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")) indexExists = true;
    if (sql === "TRUNCATE video_daily_duplicate_queue") queue.length = 0;
    if (isDuplicateScan(sql)) {
      for (const value of duplicates) {
        const [aid, record_date] = value.split("/");
        if (!queue.some((key) => key.aid === aid)) {
          queue.push({ aid, record_date });
        }
      }
    }
    if (
      sql.includes("FROM video_daily_duplicate_queue") &&
      sql.includes("LIMIT 1")
    ) {
      return { rows: queue.slice(0, 1), rowCount: queue.length ? 1 : 0 };
    }
    if (sql.includes("count(*) OVER () AS multiplicity")) {
      if (values?.[0] === "22" && failSecondKey) {
        failSecondKey = false;
        throw new Error("key repair failed");
      }
      return {
        rows: [
          {
            aid: values?.[0],
            record_date: values?.[1],
            coin: 1,
            favorite: 1,
            danmaku: 1,
            view: 1,
            reply: 1,
            share: 1,
            like: 1,
            multiplicity: 2,
          },
        ],
        rowCount: 1,
      };
    }
    if (normalizeSql(sql).startsWith("DELETE FROM video_daily WHERE")) {
      duplicates.delete(`${values?.[0]}/${values?.[1]}`);
    }
    if (
      normalizeSql(sql).startsWith("DELETE FROM video_daily_duplicate_queue")
    ) {
      queue.shift();
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(initializeVideoDaily(pool), /key repair failed/);
  assert.deepEqual([...duplicates], ["22/2026-06-03"]);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 1);
  assert.equal(queries.filter(({ sql }) => sql === "ROLLBACK").length, 1);

  await initializeVideoDaily(pool);
  assert.equal(duplicates.size, 0);
  const sourceDeletes = queries.filter(({ sql }) =>
    normalizeSql(sql).startsWith("DELETE FROM video_daily WHERE"),
  );
  assert.deepEqual(
    sourceDeletes.map(({ values }) => values),
    [
      ["11", "2026-06-02"],
      ["22", "2026-06-03"],
    ],
  );
});

test("video_daily initialization propagates index build errors", async () => {
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
  assert.equal(queries.filter(({ sql }) => sql === "ROLLBACK").length, 1);
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
