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

type DailyDate = {
  record_date: string;
};

type DuplicateCheck = {
  has_duplicates: boolean;
};

type PendingChunk = {
  chunk_schema: string;
  chunk_name: string;
};

type ExtensionCheck = {
  installed: boolean;
};

async function hasTimescaleDb(client: PoolClient): Promise<boolean> {
  const result = await client.query<ExtensionCheck>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_extension
      WHERE extname = 'timescaledb'
    ) AS installed
  `);
  return result.rows[0]?.installed ?? false;
}

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

async function getVideoDailyUniqueIndex(
  client: PoolClient,
): Promise<VideoDailyUniqueIndex | undefined> {
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
      AND index_definition.indexrelid = to_regclass('${VIDEO_DAILY_UNIQUE_INDEX}')
      AND index_key.ordinality <= index_definition.indnkeyatts
    GROUP BY
      index_definition.indexrelid,
      index_definition.indisunique,
      index_definition.indisvalid,
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

async function dropRedundantVideoDailyIndexes(
  client: PoolClient,
): Promise<void> {
  for (const indexName of REDUNDANT_VIDEO_DAILY_INDEXES) {
    await client.query(`DROP INDEX IF EXISTS ${indexName}`);
  }
}

async function recompressQueuedVideoDailyChunks(
  client: PoolClient,
): Promise<void> {
  const pendingChunks = await client.query<PendingChunk>(`
    SELECT chunk_schema::text, chunk_name::text
    FROM video_daily_recompression_queue
    ORDER BY chunk_schema, chunk_name
  `);

  for (const chunk of pendingChunks.rows) {
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const relationResult = await client.query<{
        relation_name: string | null;
      }>("SELECT to_regclass(format('%I.%I', $1, $2))::text AS relation_name", [
        chunk.chunk_schema,
        chunk.chunk_name,
      ]);
      if (!relationResult.rows[0]?.relation_name) {
        await client.query(
          `
            DELETE FROM video_daily_recompression_queue
            WHERE chunk_schema = $1
              AND chunk_name = $2
          `,
          [chunk.chunk_schema, chunk.chunk_name],
        );
        await client.query("COMMIT");
        transactionStarted = false;
        continue;
      }
      await client.query(
        "SELECT recompress_chunk(format('%I.%I', $1, $2)::regclass)",
        [chunk.chunk_schema, chunk.chunk_name],
      );
      await client.query(
        `
          DELETE FROM video_daily_recompression_queue
          WHERE chunk_schema = $1
            AND chunk_name = $2
        `,
        [chunk.chunk_schema, chunk.chunk_name],
      );
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    }
  }
}

async function cleanVideoDailyDuplicates(
  client: PoolClient,
  timescaleDbInstalled: boolean,
): Promise<void> {
  const dailyDates = await client.query<DailyDate>(`
    WITH date_bounds AS (
      SELECT min(record_date) AS first_date, max(record_date) AS last_date
      FROM video_daily
    )
    SELECT
      to_char(date_bounds.first_date + day_offset, 'YYYY-MM-DD') AS record_date
    FROM date_bounds
    CROSS JOIN LATERAL generate_series(
      0,
      date_bounds.last_date - date_bounds.first_date
    ) AS day_offset
    ORDER BY day_offset
  `);
  let temporaryTableReady = false;

  for (const row of dailyDates.rows) {
    const recordDate = dateLiteral(row.record_date);
    const duplicateCheck = await client.query<DuplicateCheck>(`
      SELECT EXISTS (
        SELECT 1
        FROM video_daily
        WHERE record_date = ${recordDate}
        GROUP BY aid
        HAVING count(*) > 1
        LIMIT 1
      ) AS has_duplicates
    `);
    if (!duplicateCheck.rows[0]?.has_duplicates) {
      continue;
    }

    if (!temporaryTableReady) {
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
      temporaryTableReady = true;
    }

    if (timescaleDbInstalled) {
      await client.query(`
        INSERT INTO video_daily_recompression_queue (chunk_schema, chunk_name)
        SELECT DISTINCT chunk.chunk_schema, chunk.chunk_name
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
        ON CONFLICT (chunk_schema, chunk_name) DO NOTHING
      `);
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
}

async function enforceVideoDailyUniqueness(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const timescaleDbInstalled = await hasTimescaleDb(client);
    if (timescaleDbInstalled) {
      await recompressQueuedVideoDailyChunks(client);
    }
    const existingIndex = await getVideoDailyUniqueIndex(client);
    if (existingIndex) {
      assertCanonicalVideoDailyIndex(existingIndex);
      await dropRedundantVideoDailyIndexes(client);
      return;
    }

    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE");
    await cleanVideoDailyDuplicates(client, timescaleDbInstalled);
    await createVideoDailyUniqueIndex(client);

    assertCanonicalVideoDailyIndex(await getVideoDailyUniqueIndex(client));
    await dropRedundantVideoDailyIndexes(client);
    await client.query("COMMIT");
    transactionStarted = false;
    if (timescaleDbInstalled) {
      await recompressQueuedVideoDailyChunks(client);
    }
  } catch (error) {
    if (transactionStarted) {
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_daily_recompression_queue (
      chunk_schema name NOT NULL,
      chunk_name   name NOT NULL,
      PRIMARY KEY (chunk_schema, chunk_name)
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
