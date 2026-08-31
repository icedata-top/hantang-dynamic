import type { Pool, PoolClient } from "pg";
import { logger } from "../../utils/logger.js";

type VideoDailyUniqueIndex = {
  index_definition: string;
  is_full_table: boolean;
  is_unique: boolean;
  is_valid: boolean;
  key_columns: string[];
};

const VIDEO_DAILY_UNIQUE_INDEX = "uq_video_daily_aid_record_date";
const REDUNDANT_VIDEO_DAILY_INDEXES = [
  "idx_video_daily_aid_date",
  "video_daily_new_aid_record_date_idx",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type DuplicateDate = {
  record_date: string;
};

type CompressedChunk = {
  chunk_name: string;
};

function isCanonicalVideoDailyIndex(index: VideoDailyUniqueIndex): boolean {
  return (
    index.is_unique &&
    index.is_valid &&
    index.is_full_table &&
    index.key_columns.length === 2 &&
    index.key_columns[0] === "aid" &&
    index.key_columns[1] === "record_date" &&
    /\bUSING btree\s*\(/i.test(index.index_definition)
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function dateLiteral(recordDate: string): string {
  if (!ISO_DATE.test(recordDate)) {
    throw new Error(`Invalid video_daily duplicate date: ${recordDate}`);
  }
  return `DATE '${recordDate}'`;
}

async function createVideoDailyUniqueIndex(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${VIDEO_DAILY_UNIQUE_INDEX}
    ON video_daily(aid, record_date ASC)
  `);
}

async function cleanVideoDailyDuplicates(
  client: PoolClient,
): Promise<Set<string>> {
  const duplicateDates = await client.query<DuplicateDate>(`
    SELECT duplicate_keys.record_date::text AS record_date
    FROM (
      SELECT record_date, aid
      FROM video_daily
      GROUP BY record_date, aid
      HAVING count(*) > 1
    ) AS duplicate_keys
    GROUP BY duplicate_keys.record_date
    ORDER BY duplicate_keys.record_date
  `);
  const compressedChunks = new Set<string>();

  if (duplicateDates.rows.length === 0) {
    return compressedChunks;
  }

  await client.query(`
    CREATE TEMP TABLE video_daily_deduplicated (
      record_date  date     NOT NULL,
      aid          bigint   NOT NULL,
      coin         integer,
      favorite     integer,
      danmaku      integer,
      "view"       integer,
      reply        integer,
      share        integer,
      "like"       integer
    ) ON COMMIT DROP
  `);

  for (const row of duplicateDates.rows) {
    const recordDate = dateLiteral(row.record_date);
    const chunkResult = await client.query<CompressedChunk>(`
      SELECT DISTINCT
        format('%I.%I', chunk.chunk_schema, chunk.chunk_name) AS chunk_name
      FROM video_daily AS daily
      JOIN pg_class AS chunk_relation
        ON chunk_relation.oid = daily.tableoid
      JOIN pg_namespace AS chunk_namespace
        ON chunk_namespace.oid = chunk_relation.relnamespace
      JOIN timescaledb_information.chunks AS chunk
        ON chunk.chunk_schema = chunk_namespace.nspname
       AND chunk.chunk_name = chunk_relation.relname
      WHERE daily.record_date = ${recordDate}
        AND chunk.hypertable_schema = current_schema()
        AND chunk.hypertable_name = 'video_daily'
        AND chunk.is_compressed
    `);
    for (const chunk of chunkResult.rows) {
      compressedChunks.add(chunk.chunk_name);
    }

    await client.query("TRUNCATE video_daily_deduplicated");
    await client.query(`
      INSERT INTO video_daily_deduplicated (
        record_date, aid, coin, favorite, danmaku,
        "view", reply, share, "like"
      )
      SELECT DISTINCT ON (aid)
        record_date, aid, coin, favorite, danmaku,
        "view", reply, share, "like"
      FROM video_daily
      WHERE record_date = ${recordDate}
      ORDER BY
        aid,
        "view" ASC NULLS LAST,
        coin ASC NULLS LAST,
        favorite ASC NULLS LAST,
        danmaku ASC NULLS LAST,
        reply ASC NULLS LAST,
        share ASC NULLS LAST,
        "like" ASC NULLS LAST
    `);
    await client.query(`
      DELETE FROM video_daily
      WHERE record_date = ${recordDate}
    `);
    await client.query(`
      INSERT INTO video_daily (
        record_date, aid, coin, favorite, danmaku,
        "view", reply, share, "like"
      )
      SELECT
        record_date, aid, coin, favorite, danmaku,
        "view", reply, share, "like"
      FROM video_daily_deduplicated
      WHERE record_date = ${recordDate}
    `);
  }

  return compressedChunks;
}

async function enforceVideoDailyUniqueness(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const compressedChunks = new Set<string>();
  let transactionFinished = false;
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE");
    await client.query("SAVEPOINT video_daily_unique_index_build");
    try {
      await createVideoDailyUniqueIndex(client);
      await client.query("RELEASE SAVEPOINT video_daily_unique_index_build");
    } catch (error) {
      await client.query(
        "ROLLBACK TO SAVEPOINT video_daily_unique_index_build",
      );
      await client.query("RELEASE SAVEPOINT video_daily_unique_index_build");
      if (!isUniqueViolation(error)) {
        throw error;
      }

      for (const chunk of await cleanVideoDailyDuplicates(client)) {
        compressedChunks.add(chunk);
      }
      await createVideoDailyUniqueIndex(client);
    }

    const uniqueIndexResult = await client.query<VideoDailyUniqueIndex>(`
      SELECT
        index_definition.indexrelid::regclass::text AS index_name,
        index_definition.indisunique AS is_unique,
        index_definition.indisvalid AS is_valid,
        index_definition.indpred IS NULL AS is_full_table,
        array_agg(attribute.attname ORDER BY index_key.ordinality) AS key_columns,
        pg_get_indexdef(index_definition.indexrelid) AS index_definition
      FROM pg_index AS index_definition
      CROSS JOIN LATERAL unnest(index_definition.indkey::smallint[])
        WITH ORDINALITY AS index_key(attnum, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = index_definition.indrelid
       AND attribute.attnum = index_key.attnum
      WHERE index_definition.indrelid = 'video_daily'::regclass
        AND index_definition.indexrelid = '${VIDEO_DAILY_UNIQUE_INDEX}'::regclass
        AND index_key.ordinality <= index_definition.indnkeyatts
      GROUP BY
        index_definition.indexrelid,
        index_definition.indisunique,
        index_definition.indisvalid,
        index_definition.indpred
    `);
    const uniqueIndex = uniqueIndexResult.rows[0];
    if (!uniqueIndex || !isCanonicalVideoDailyIndex(uniqueIndex)) {
      throw new Error(
        `video_daily index ${VIDEO_DAILY_UNIQUE_INDEX} must be a valid unique btree index on (aid, record_date)`,
      );
    }

    for (const indexName of REDUNDANT_VIDEO_DAILY_INDEXES) {
      await client.query(`DROP INDEX IF EXISTS ${indexName}`);
    }
    await client.query("COMMIT");
    transactionFinished = true;

    for (const chunk of compressedChunks) {
      await client.query("SELECT recompress_chunk($1::regclass)", [chunk]);
    }
  } catch (error) {
    if (!transactionFinished) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function initVideoDailySchema(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE FOREIGN TABLE IF NOT EXISTS mysql_video_daily (
        record_date  date,
        aid          bigint,
        coin         integer,
        favorite     integer,
        danmaku      integer,
        "view"       integer,
        reply        integer,
        share        integer,
        "like"       integer
      )
      SERVER mysql_hantang_server
      OPTIONS (dbname 'hantang_dynamic', table_name 'video_daily')
    `);
    logger.debug("mysql_video_daily: foreign table ready");
  } catch {
    logger.debug("mysql_video_daily: skipped (mysql_fdw not configured)");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_daily (
      record_date  date     NOT NULL,
      aid          bigint   NOT NULL,
      coin         integer,
      favorite     integer,
      danmaku      integer,
      "view"       integer,
      reply        integer,
      share        integer,
      "like"       integer
    )
  `);
  await enforceVideoDailyUniqueness(pool);

  try {
    await pool.query(`
      SELECT create_hypertable(
        'video_daily',
        by_range('record_date', INTERVAL '90 days'),
        if_not_exists => TRUE,
        migrate_data  => TRUE
      )
    `);
    await pool.query(`
      ALTER TABLE video_daily SET (
        timescaledb.compress           = true,
        timescaledb.compress_segmentby = '',
        timescaledb.compress_orderby   = 'aid, record_date ASC'
      )
    `);
    await pool.query(`
      SELECT add_compression_policy(
        'video_daily',
        compress_after => INTERVAL '7 days',
        if_not_exists  => TRUE
      )
    `);
    logger.info("video_daily: schema ready");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`video_daily: schema setup skipped (${msg})`);
  }
}
