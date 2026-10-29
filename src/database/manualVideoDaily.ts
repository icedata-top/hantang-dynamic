import type { Pool, PoolClient } from "pg";

const columns = [
  "record_date",
  "aid",
  "coin",
  "favorite",
  "danmaku",
  "view",
  "reply",
  "share",
  "like",
];
const quoted = columns.map((column) => `"${column}"`).join(",");
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function syncVideoDailyRange(
  pool: Pool,
  options: {
    startDate: string;
    endDate: string;
    schema: string;
    businessTimezone: string;
    aidBatchSize?: number;
    onProgress?: (message: string) => void;
  },
): Promise<void> {
  const { startDate, endDate } = options;
  for (const date of [startDate, endDate]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new Error("Dates must be valid YYYY-MM-DD dates");
  }
  if (startDate > endDate)
    throw new Error("Start date must not exceed end date");
  const size = options.aidBatchSize ?? 5000;
  if (!Number.isSafeInteger(size) || size < 1 || size > 2147483647)
    throw new Error("--aid-batch-size must be a positive PostgreSQL integer");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: options.businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const pg = await pool.connect();
  try {
    await backfillVideoDaily(pg, { ...options, today, size });
  } finally {
    pg.release(true);
  }
}

// The caller owns the PG connection; the worker holds the shared sync lock.
export async function backfillVideoDaily(
  pg: PoolClient,
  options: {
    startDate: string;
    endDate: string;
    schema: string;
    today: string;
    size: number;
    onProgress?: (message: string) => void;
  },
): Promise<void> {
  const { startDate, endDate, schema, today, size } = options;
  const target = `${identifier(schema)}.video_daily`;
  const sourceTable = `${identifier(schema)}.mysql_video_daily`;
  let locked = false;
  try {
    await pg.query(
      "SELECT pg_advisory_lock(hashtextextended($1 || '.video_daily_mysql_sync', 0))",
      [schema],
    );
    locked = true;
    await pg.query(
      `CREATE TEMP TABLE manual_daily_batch (LIKE ${target} INCLUDING DEFAULTS, PRIMARY KEY(record_date,aid)) ON COMMIT PRESERVE ROWS`,
    );
    async function batches(
      from: string,
      through: string,
      insert: boolean,
      compressedChunk?: string,
    ): Promise<void> {
      const completeDays = new Map<string, boolean>();
      async function recordCoverage(firstAid: string, lastAid: string) {
        const coverage = await pg.query<{ date: string; complete: boolean }>(
          `SELECT b.record_date::text AS date,
             bool_and(EXISTS (SELECT 1 FROM ${target} t
               WHERE t.record_date >= $1::date AND t.record_date <= $2::date
                 AND t.aid >= $3::bigint AND t.aid <= $4::bigint
                 AND (t.record_date,t.aid)=(b.record_date,b.aid))) AS complete
           FROM pg_temp.manual_daily_batch b GROUP BY b.record_date`,
          [from, through, firstAid, lastAid],
        );
        for (const row of coverage.rows)
          completeDays.set(
            row.date,
            completeDays.get(row.date) !== false && row.complete,
          );
      }
      let after = "-9223372036854775808";
      while (true) {
        const aids = await pg.query<{ aid: string }>(
          `SELECT aid FROM ${sourceTable}
           WHERE record_date >= $1::date AND record_date <= $2::date
             AND aid > $3::bigint GROUP BY aid ORDER BY aid LIMIT $4::integer`,
          [from, through, after, size],
        );
        if (!aids.rows.length) break;
        const firstAid = String(aids.rows[0].aid);
        const last = String(aids.rows[aids.rows.length - 1].aid);
        await pg.query("TRUNCATE pg_temp.manual_daily_batch");
        const selected = insert ? quoted : '"record_date","aid"';
        let cursorAid = after;
        let cursorDate = "0001-01-01";
        while (true) {
          const page = await pg.query<{ aid: string; record_date: string }>(
            `WITH page AS (
               SELECT ${selected} FROM ${sourceTable}
               WHERE record_date >= $1::date AND record_date <= $2::date
                 AND aid > $3::bigint AND aid <= $4::bigint
                 AND (aid > $5::bigint OR (aid = $5::bigint AND record_date > $6::date))
               ORDER BY aid,record_date LIMIT 1000
             ), staged AS (
               INSERT INTO pg_temp.manual_daily_batch (${selected})
               SELECT ${selected} FROM page RETURNING aid,record_date
             ) SELECT aid::text,record_date::text FROM staged ORDER BY staged.aid,staged.record_date`,
            [from, through, after, last, cursorAid, cursorDate],
          );
          if (!page.rows.length) break;
          const tail = page.rows[page.rows.length - 1];
          cursorAid = tail.aid;
          cursorDate = tail.record_date;
          if (!insert) {
            await recordCoverage(firstAid, last);
            await pg.query("TRUNCATE pg_temp.manual_daily_batch");
          }
        }
        if (insert) {
          await pg.query("BEGIN");
          let inserted = 0;
          try {
            const result = await pg.query(
              `INSERT INTO ${target} (${quoted}) SELECT ${quoted} FROM pg_temp.manual_daily_batch b
               WHERE NOT EXISTS (SELECT 1 FROM ${target} t
                 WHERE t.record_date >= $1::date AND t.record_date <= $2::date
                   AND t.aid > $3::bigint AND t.aid <= $4::bigint
                   AND (t.record_date,t.aid)=(b.record_date,b.aid))`,
              [from, through, after, last],
            );
            inserted = result.rowCount ?? 0;
            await pg.query("COMMIT");
          } catch (error) {
            await pg.query("ROLLBACK");
            throw error;
          }
          if (inserted && compressedChunk)
            await pg.query("CALL convert_to_columnstore($1::regclass)", [
              compressedChunk,
            ]);
          await recordCoverage(firstAid, last);
        }
        options.onProgress?.(
          `video_daily ${insert ? "insert" : "cleanup"}: ${from} through ${through}, aid ${last}`,
        );
        after = last;
      }
      // Source history is immutable. Delete only after every aid in the window
      // has been checked; mysql_fdw identifies remote deletions by record_date.
      for (const [date, complete] of completeDays) {
        if (!complete || date >= today) continue;
        await pg.query(
          `DELETE FROM ${sourceTable} WHERE record_date = $1::date AND record_date < $2::date`,
          [date, today],
        );
        options.onProgress?.(
          `video_daily cleanup: deleted complete date ${date}`,
        );
      }
    }
    const cleanupWindows = await pg.query<{ start: string; finish: string }>(
      `SELECT greatest((range_start AT TIME ZONE 'UTC')::date, $2::date)::text AS start,
         least((range_end AT TIME ZONE 'UTC')::date - 1, $3::date)::text AS finish
       FROM timescaledb_information.chunks
       WHERE hypertable_schema = $1 AND hypertable_name = 'video_daily'
         AND (range_end AT TIME ZONE 'UTC')::date > $2::date
         AND (range_start AT TIME ZONE 'UTC')::date <= $3::date
       ORDER BY range_start`,
      [schema, startDate, endDate],
    );
    for (const window of cleanupWindows.rows) {
      await batches(window.start, window.finish, false);
    }
    let from = startDate;
    while (from <= endDate) {
      const first = await pg.query(
        `SELECT record_date::text,aid::text,coin,favorite,danmaku,"view",reply,share,"like" FROM ${sourceTable} WHERE record_date >= $1::date AND record_date <= $2::date ORDER BY ${sourceTable}.record_date,${sourceTable}.aid LIMIT 1`,
        [from, endDate],
      );
      if (!first.rows.length) break;
      from = String(first.rows[0].record_date);
      const findChunk = () =>
        pg.query(
          `SELECT format('%I.%I',chunk_schema,chunk_name) AS name, is_compressed, ((range_end AT TIME ZONE 'UTC')::date-1)::text AS finish FROM timescaledb_information.chunks WHERE hypertable_schema=$1 AND hypertable_name='video_daily' AND (range_start AT TIME ZONE 'UTC')::date <= $2::date AND (range_end AT TIME ZONE 'UTC')::date > $2::date`,
          [schema, from],
        );
      let chunk = (await findChunk()).rows[0];
      if (!chunk) {
        // Seed one row so Timescale chooses the real chunk bounds. Keep its
        // source record until its entire date has been verified.
        const values = columns.map((column) => first.rows[0][column]);
        await pg.query(
          `INSERT INTO ${target} (${quoted}) SELECT ${columns.map((_, i) => `$${i + 1}`).join(",")} WHERE NOT EXISTS (SELECT 1 FROM ${target} WHERE record_date=$1::date AND aid=$2::bigint)`,
          values,
        );
        chunk = (await findChunk()).rows[0];
        if (!chunk)
          throw new Error(`Timescale did not create a chunk for ${from}`);
      }
      const through = chunk.finish < endDate ? chunk.finish : endDate;
      await batches(
        from,
        through,
        true,
        chunk.is_compressed ? chunk.name : undefined,
      );
      from = new Date(Date.parse(through) + 86400000)
        .toISOString()
        .slice(0, 10);
    }
  } finally {
    if (locked) {
      try {
        await pg.query("DROP TABLE IF EXISTS pg_temp.manual_daily_batch");
      } finally {
        await pg.query(
          "SELECT pg_advisory_unlock(hashtextextended($1 || '.video_daily_mysql_sync', 0))",
          [schema],
        );
      }
    }
  }
}
