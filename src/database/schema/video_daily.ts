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
type DuplicateKey = {
  aid: string;
  record_date: string;
};

type CanonicalDailyRow = DuplicateKey & {
  coin: number | null;
  favorite: number | null;
  danmaku: number | null;
  view: number | null;
  reply: number | null;
  share: number | null;
  like: number | null;
  multiplicity: number | string;
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

async function queueVideoDailyDuplicates(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO video_daily_duplicate_queue (aid, record_date)
    SELECT aid, record_date
    FROM video_daily
    GROUP BY aid, record_date
    HAVING count(*) > 1
    ON CONFLICT (aid, record_date) DO NOTHING
  `);
}

async function getNextDuplicateKey(
  client: PoolClient,
): Promise<DuplicateKey | undefined> {
  const result = await client.query<DuplicateKey>(`
    SELECT aid::text, to_char(record_date, 'YYYY-MM-DD') AS record_date
    FROM video_daily_duplicate_queue
    ORDER BY record_date, aid
    LIMIT 1
  `);
  return result.rows[0];
}

async function repairVideoDailyDuplicate(
  client: PoolClient,
  key: DuplicateKey,
): Promise<void> {
  const result = await client.query<CanonicalDailyRow>(
    `
      SELECT
        aid::text,
        to_char(record_date, 'YYYY-MM-DD') AS record_date,
        coin,
        favorite,
        danmaku,
        "view" AS view,
        reply,
        share,
        "like" AS like,
        count(*) OVER () AS multiplicity
      FROM video_daily
      WHERE aid = $1
        AND record_date = $2
      ORDER BY
        "view" ASC NULLS LAST,
        coin ASC NULLS LAST,
        favorite ASC NULLS LAST,
        danmaku ASC NULLS LAST,
        reply ASC NULLS LAST,
        share ASC NULLS LAST,
        "like" ASC NULLS LAST
      LIMIT 1
    `,
    [key.aid, key.record_date],
  );
  const canonical = result.rows[0];

  if (canonical && Number(canonical.multiplicity) > 1) {
    await client.query(
      `
        DELETE FROM video_daily
        WHERE aid = $1
          AND record_date = $2
      `,
      [key.aid, key.record_date],
    );
    await client.query(
      `
        INSERT INTO video_daily (
          record_date, aid, coin, favorite, danmaku,
          "view", reply, share, "like"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        canonical.record_date,
        canonical.aid,
        canonical.coin,
        canonical.favorite,
        canonical.danmaku,
        canonical.view,
        canonical.reply,
        canonical.share,
        canonical.like,
      ],
    );
  }

  await client.query(
    `
      DELETE FROM video_daily_duplicate_queue
      WHERE aid = $1
        AND record_date = $2
    `,
    [key.aid, key.record_date],
  );
}

async function enforceVideoDailyUniqueness(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const existingIndex = await getVideoDailyUniqueIndex(client);
    if (existingIndex) {
      assertCanonicalVideoDailyIndex(existingIndex);
      await dropRedundantVideoDailyIndexes(client);
      return;
    }

    await client.query(`
      CREATE TEMP TABLE IF NOT EXISTS video_daily_duplicate_queue (
        aid         bigint NOT NULL,
        record_date date   NOT NULL,
        PRIMARY KEY (aid, record_date)
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query("TRUNCATE video_daily_duplicate_queue");
    await queueVideoDailyDuplicates(client);

    while (true) {
      const duplicateKey = await getNextDuplicateKey(client);
      if (duplicateKey) {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          "LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE",
        );
        await repairVideoDailyDuplicate(client, duplicateKey);
        await client.query("COMMIT");
        transactionStarted = false;
        continue;
      }

      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("LOCK TABLE video_daily IN SHARE ROW EXCLUSIVE MODE");
      await queueVideoDailyDuplicates(client);
      if (await getNextDuplicateKey(client)) {
        await client.query("COMMIT");
        transactionStarted = false;
        continue;
      }

      await createVideoDailyUniqueIndex(client);
      assertCanonicalVideoDailyIndex(await getVideoDailyUniqueIndex(client));
      await dropRedundantVideoDailyIndexes(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return;
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
