import {
  type Connection,
  createConnection,
  type RowDataPacket,
} from "mysql2/promise";
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
const mysqlColumns = columns.map((column) => `\`${column}\``).join(",");
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function syncVideoDailyRange(
  pool: Pool,
  options: {
    startDate: string;
    endDate: string;
    schema: string;
    mysqlUrl: string;
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
  try {
    const url = new URL(options.mysqlUrl);
    if (url.protocol !== "mysql:" || !url.pathname.slice(1)) throw new Error();
  } catch {
    throw new Error(
      "VIDEO_DAILY_MYSQL_URL must be a MySQL URL with a database name",
    );
  }
  const source = await createConnection({
    uri: options.mysqlUrl,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  let pg: PoolClient | undefined;
  try {
    pg = await pool.connect();
    await backfillVideoDaily(pg, source, { ...options, today, size });
  } finally {
    pg?.release(true);
    await source.end();
  }
}

// Connections are owned by the caller; the worker holds the shared sync lock.
export async function backfillVideoDaily(
  pg: PoolClient,
  source: Pick<Connection, "execute" | "query">,
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
    async function removeVerified(
      from: string,
      through: string,
      firstAid: string,
      lastAid: string,
    ): Promise<void> {
      let date = "0001-01-01",
        aid = "-9223372036854775808";
      while (true) {
        const keys = await pg.query(
          `SELECT b.record_date::text, b.aid::text FROM pg_temp.manual_daily_batch b WHERE b.record_date < $1::date AND (b.record_date,b.aid)>($2::date,$3::bigint) AND EXISTS (SELECT 1 FROM ${target} t WHERE t.record_date >= $4::date AND t.record_date <= $5::date AND t.aid >= $6::bigint AND t.aid <= $7::bigint AND (t.record_date,t.aid)=(b.record_date,b.aid)) ORDER BY b.record_date,b.aid LIMIT 1000`,
          [today, date, aid, from, through, firstAid, lastAid],
        );
        if (!keys.rows.length) break;
        const values = keys.rows.flatMap((row) => [row.record_date, row.aid]);
        await source.execute(
          `DELETE FROM video_daily WHERE (record_date,aid) IN (${keys.rows.map(() => "(?,CAST(? AS SIGNED))").join(",")})`,
          values,
        );
        const last = keys.rows[keys.rows.length - 1];
        date = last.record_date;
        aid = last.aid;
      }
    }
    async function stage(
      from: string,
      through: string,
      after: string,
      last: string,
      cleanup: boolean,
    ): Promise<void> {
      await pg.query("TRUNCATE pg_temp.manual_daily_batch");
      const selectedColumns = cleanup ? columns.slice(0, 2) : columns;
      const sourceColumns = selectedColumns
        .map((column) => `\`${column}\``)
        .join(",");
      const targetColumns = selectedColumns.map(identifier).join(",");
      let cursorAid = after,
        cursorDate = "0001-01-01";
      while (true) {
        const [rows] = await source.execute<RowDataPacket[]>(
          `SELECT ${sourceColumns} FROM video_daily WHERE record_date >= ? AND record_date <= ? AND aid > CAST(? AS SIGNED) AND aid <= CAST(? AS SIGNED) AND (aid,record_date)>(CAST(? AS SIGNED),?) ORDER BY aid,record_date LIMIT 1000`,
          [from, through, after, last, cursorAid, cursorDate],
        );
        if (!rows.length) break;
        const values = rows.flatMap((row) =>
          selectedColumns.map((column) => row[column]),
        );
        await pg.query(
          `INSERT INTO pg_temp.manual_daily_batch (${targetColumns}) VALUES ${rows.map((_, i) => `(${selectedColumns.map((_, j) => `$${i * selectedColumns.length + j + 1}`).join(",")})`).join(",")}`,
          values,
        );
        const tail = rows[rows.length - 1];
        cursorAid = String(tail.aid);
        cursorDate = String(tail.record_date);
        if (cleanup) {
          const dates = rows.map((row) => String(row.record_date));
          await removeVerified(
            dates.reduce((a, b) => (a < b ? a : b)),
            dates.reduce((a, b) => (a > b ? a : b)),
            String(rows[0].aid),
            String(tail.aid),
          );
          await pg.query("TRUNCATE pg_temp.manual_daily_batch");
        }
      }
    }
    async function batches(
      from: string,
      through: string,
      insert: boolean,
      compressedChunk?: string,
    ): Promise<void> {
      let after = "-9223372036854775808";
      while (true) {
        const [aids] = await source.query<RowDataPacket[]>(
          `SELECT DISTINCT aid FROM video_daily WHERE record_date >= ? AND record_date <= ? AND aid > CAST(? AS SIGNED) ORDER BY aid LIMIT ${size}`,
          [from, through, after],
        );
        if (!aids.length) break;
        const last = String(aids[aids.length - 1].aid);
        await stage(from, through, after, last, !insert);
        if (insert) {
          await pg.query("BEGIN");
          let inserted = 0;
          try {
            const result = await pg.query(
              `INSERT INTO ${target} (${quoted}) SELECT ${quoted} FROM pg_temp.manual_daily_batch b WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.record_date >= $1::date AND t.record_date <= $2::date AND t.aid > $3::bigint AND t.aid <= $4::bigint AND (t.record_date,t.aid)=(b.record_date,b.aid))`,
              [from, through, after, last],
            );
            inserted = result.rowCount ?? 0;
            await pg.query("COMMIT");
          } catch (error) {
            await pg.query("ROLLBACK");
            throw error;
          }
          if (inserted && compressedChunk) {
            await pg.query("CALL convert_to_columnstore($1::regclass)", [
              compressedChunk,
            ]);
          }
        }
        if (insert)
          await removeVerified(from, through, String(aids[0].aid), last);
        options.onProgress?.(
          `video_daily ${insert ? "insert" : "cleanup"}: ${from} through ${through}, aid ${last}`,
        );
        after = last;
      }
    }
    await batches(startDate, endDate, false);
    let from = startDate;
    while (from <= endDate) {
      const [first] = await source.execute<RowDataPacket[]>(
        `SELECT ${mysqlColumns} FROM video_daily WHERE record_date >= ? AND record_date <= ? ORDER BY record_date,aid LIMIT 1`,
        [from, endDate],
      );
      if (!first.length) break;
      from = String(first[0].record_date);
      const findChunk = () =>
        pg.query(
          `SELECT format('%I.%I',chunk_schema,chunk_name) AS name, is_compressed, ((range_end AT TIME ZONE 'UTC')::date-1)::text AS finish FROM timescaledb_information.chunks WHERE hypertable_schema=$1 AND hypertable_name='video_daily' AND (range_start AT TIME ZONE 'UTC')::date <= $2::date AND (range_end AT TIME ZONE 'UTC')::date > $2::date`,
          [schema, from],
        );
      let chunk = (await findChunk()).rows[0];
      if (!chunk) {
        // Seed one row so Timescale chooses the real chunk bounds. Keep its
        // source record until the following aid batch has completed.
        const values = columns.map((column) => first[0][column]);
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
