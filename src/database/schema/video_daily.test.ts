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
  is_ready: true,
  is_unique: true,
  is_valid: true,
  key_columns: ["aid", "record_date"],
};

function createPool(indexRows: unknown[]): {
  pool: Pool;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
      queries.push({ sql, values });
      if (sql.includes("FROM pg_index AS index_definition")) {
        return { rows: indexRows, rowCount: indexRows.length };
      }
      return { rows: [], rowCount: 0 };
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

function initializationSql(queries: RecordedQuery[]): string {
  return queries.map(({ sql }) => sql.replace(/\s+/g, " ").trim()).join("\n");
}

function assertNoHistoricalMaintenance(queries: RecordedQuery[]): void {
  const sql = initializationSql(queries);
  assert.doesNotMatch(sql, /GROUP BY aid, record_date/i);
  assert.doesNotMatch(sql, /video_daily_duplicate_queue/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /LOCK TABLE video_daily/i);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/i);
  assert.doesNotMatch(sql, /DROP INDEX/i);
  assert.doesNotMatch(sql, /FROM video_daily(?:\s|$)/i);
}

test("video_daily initialization leaves historical data untouched when the canonical index is absent", async () => {
  const { pool, queries } = createPool([]);

  await initializeVideoDaily(pool);

  assert.equal(
    queries.filter(({ sql }) =>
      sql.includes("FROM pg_index AS index_definition"),
    ).length,
    1,
  );
  assertNoHistoricalMaintenance(queries);
});

test("video_daily initialization accepts the canonical unique index", async () => {
  const { pool, queries } = createPool([canonicalIndex]);

  await initializeVideoDaily(pool);

  assertNoHistoricalMaintenance(queries);
});

test("video_daily initialization rejects malformed canonical index metadata", async (t) => {
  const malformedIndexes = [
    ["non-unique", { ...canonicalIndex, is_unique: false }],
    ["invalid", { ...canonicalIndex, is_valid: false }],
    ["not ready", { ...canonicalIndex, is_ready: false }],
    ["partial", { ...canonicalIndex, is_full_table: false }],
    [
      "wrong key order",
      {
        ...canonicalIndex,
        index_definition:
          "CREATE UNIQUE INDEX uq_video_daily_aid_record_date ON hantang_dynamic.video_daily USING btree (record_date, aid)",
        key_columns: ["record_date", "aid"],
      },
    ],
    [
      "wrong access method",
      {
        ...canonicalIndex,
        index_definition:
          "CREATE UNIQUE INDEX uq_video_daily_aid_record_date ON hantang_dynamic.video_daily USING hash (aid, record_date)",
      },
    ],
  ] as const;

  for (const [name, index] of malformedIndexes) {
    await t.test(name, async () => {
      const { pool, queries } = createPool([index]);

      await assert.rejects(
        initializeVideoDaily(pool),
        /must be a valid unique btree index on \(aid, record_date\)/,
      );
      assertNoHistoricalMaintenance(queries);
    });
  }
});
