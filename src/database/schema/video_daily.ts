import type { Pool } from "pg";
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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${VIDEO_DAILY_UNIQUE_INDEX}
    ON video_daily(aid, record_date ASC)
  `);

  const uniqueIndexResult = await pool.query<VideoDailyUniqueIndex>(`
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
    await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
  }

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
