import type { Pool, PoolClient } from "pg";
import { logger } from "../../utils/logger.js";

type VideoDailyUniqueIndex = {
  index_definition: string;
  is_full_table: boolean;
  is_ready: boolean;
  is_unique: boolean;
  is_valid: boolean;
  key_columns: string[];
};

const VIDEO_DAILY_UNIQUE_INDEX = "uq_video_daily_aid_record_date";

function isCanonicalVideoDailyIndex(index: VideoDailyUniqueIndex): boolean {
  return (
    index.is_unique &&
    index.is_valid &&
    index.is_ready &&
    index.is_full_table &&
    index.key_columns.length === 2 &&
    index.key_columns[0] === "aid" &&
    index.key_columns[1] === "record_date" &&
    /\bUSING btree\s*\(/i.test(index.index_definition)
  );
}

async function getVideoDailyUniqueIndex(
  client: PoolClient,
): Promise<VideoDailyUniqueIndex | undefined> {
  const uniqueIndexResult = await client.query<VideoDailyUniqueIndex>(`
    SELECT
      index_definition.indexrelid::regclass::text AS index_name,
      index_definition.indisunique AS is_unique,
      index_definition.indisvalid AS is_valid,
      index_definition.indisready AS is_ready,
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
      AND index_definition.indexrelid = to_regclass('${VIDEO_DAILY_UNIQUE_INDEX}')
      AND index_key.ordinality <= index_definition.indnkeyatts
    GROUP BY
      index_definition.indexrelid,
      index_definition.indisunique,
      index_definition.indisvalid,
      index_definition.indisready,
      index_definition.indpred
  `);
  return uniqueIndexResult.rows[0];
}

function assertCanonicalVideoDailyIndex(
  index: VideoDailyUniqueIndex | undefined,
): void {
  if (!index || !isCanonicalVideoDailyIndex(index)) {
    throw new Error(
      `video_daily index ${VIDEO_DAILY_UNIQUE_INDEX} must be a valid unique btree index on (aid, record_date)`,
    );
  }
}

async function validateVideoDailyUniquenessIndex(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const existingIndex = await getVideoDailyUniqueIndex(client);
    if (!existingIndex) {
      logger.warn(
        `video_daily: canonical index ${VIDEO_DAILY_UNIQUE_INDEX} is absent; automatic historical duplicate repair and index creation are skipped. An explicit maintenance procedure is required to establish the canonical index`,
      );
      return;
    }
    assertCanonicalVideoDailyIndex(existingIndex);
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
  await validateVideoDailyUniquenessIndex(pool);

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
