import type { Pool, PoolClient } from "pg";
import { videoDailySource } from "./videoDailySource";

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

function validateAidBatchSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > 2147483647)
    throw new Error("--aid-batch-size must be a positive PostgreSQL integer");
}

export async function syncVideoDailyRange(
  pool: Pool,
  options: {
    startDate: string;
    endDate: string;
    schema: string;
    businessTimezone: string;
    aidBatchSize?: number;
    keepSource?: boolean;
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
  validateAidBatchSize(size);
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

const DAY_MS = 86400000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

function dateRange(from: string, through: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= through; date = addDays(date, 1))
    dates.push(date);
  return dates;
}

type Progress = ((message: string) => void) | undefined;

async function timed<T>(
  onProgress: Progress,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  onProgress?.(`video_daily ${name}: started`);
  const started = Date.now();
  try {
    const result = await work();
    onProgress?.(`video_daily ${name}: completed in ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    onProgress?.(`video_daily ${name}: failed after ${Date.now() - started}ms`);
    throw error;
  }
}

type WindowContext = {
  pg: PoolClient;
  target: string;
  sourceTable: string;
  size: number;
  onProgress: Progress;
};

// Source rows for the given dates and an aid range. Parameters: $3 = exclusive
// lower aid, $4 = inclusive upper aid, $5.. = one per date.
const sourceSql = (ctx: WindowContext, dates: string[], selected: string) =>
  dates
    .map(
      (_, i) => `SELECT ${selected} FROM ${ctx.sourceTable}
          WHERE record_date = $${i + 5}::date
            AND aid > $3::bigint AND aid <= $4::bigint`,
    )
    .join(" UNION ALL ");

// Walks one chunk-aligned date window in aid batches. When insert is true,
// missing keys are copied first; either way every batch's target coverage is
// checked. Returns whether each source date is fully present in the target.
async function syncWindow(
  ctx: WindowContext,
  from: string,
  through: string,
  insert: boolean,
  compressedChunk?: string,
): Promise<Map<string, boolean>> {
  const { pg, target, sourceTable, size, onProgress } = ctx;
  const completeDays = new Map<string, boolean>();
  const dates = dateRange(from, through);
  const phase = <T>(name: string, work: () => Promise<T>) =>
    timed(onProgress, name, work);
  async function recordCoverage(after: string, last: string) {
    const coverage = await phase(
      `coverage ${from} through ${through}, aid (${after}, ${last}]`,
      () =>
        pg.query<{ date: string; complete: boolean }>(
          `SELECT b.record_date::text AS date,
               bool_and(t.aid IS NOT NULL) AS complete
             FROM (${sourceSql(ctx, dates, '"record_date","aid"')}) b
             LEFT JOIN ${target} t
               ON t.record_date >= $1::date AND t.record_date <= $2::date
                 AND t.aid > $3::bigint AND t.aid <= $4::bigint
                 AND (t.record_date,t.aid)=(b.record_date,b.aid)
             GROUP BY b.record_date`,
          [from, through, after, last, ...dates],
        ),
    );
    for (const row of coverage.rows)
      completeDays.set(
        row.date,
        completeDays.get(row.date) !== false && row.complete,
      );
  }
  async function insertBatch(after: string, last: string) {
    await pg.query("BEGIN");
    let inserted = 0;
    try {
      const result = await phase(
        `insert ${from} through ${through}, aid (${after}, ${last}]`,
        () =>
          pg.query(
            `INSERT INTO ${target} (${quoted}) SELECT ${quoted} FROM (${sourceSql(ctx, dates, quoted)}) b
               WHERE NOT EXISTS (SELECT 1 FROM ${target} t
                 WHERE t.record_date >= $1::date AND t.record_date <= $2::date
                   AND t.aid > $3::bigint AND t.aid <= $4::bigint
                   AND (t.record_date,t.aid)=(b.record_date,b.aid))`,
            [from, through, after, last, ...dates],
          ),
      );
      inserted = result.rowCount ?? 0;
      await pg.query("COMMIT");
      onProgress?.(`video_daily committed ${inserted} inserted rows`);
    } catch (error) {
      await pg.query("ROLLBACK");
      throw error;
    }
    if (inserted && compressedChunk)
      await phase(`compression ${compressedChunk}`, () =>
        pg.query("CALL convert_to_columnstore($1::regclass)", [
          compressedChunk,
        ]),
      );
  }
  let after = "-9223372036854775808";
  let cursorOpen = false;
  // WITH HOLD materializes distinct aids once and survives batch commits.
  try {
    await phase(
      `aid cursor preparation ${from} through ${through}`,
      async () => {
        await pg.query(
          `DECLARE manual_daily_aids NO SCROLL CURSOR WITH HOLD FOR
             SELECT aid FROM ${sourceTable}
             WHERE record_date >= $1::date AND record_date <= $2::date
               AND aid > $3::bigint GROUP BY aid ORDER BY aid`,
          [from, through, after],
        );
        cursorOpen = true;
      },
    );
    while (true) {
      const aids = await phase(
        `aid cursor fetch ${from} through ${through}, after ${after}, limit ${size}`,
        () =>
          pg.query<{ aid: string }>(
            `FETCH FORWARD ${size} FROM manual_daily_aids`,
          ),
      );
      if (!aids.rows.length) break;
      const last = String(aids.rows[aids.rows.length - 1].aid);
      if (insert) await insertBatch(after, last);
      await recordCoverage(after, last);
      onProgress?.(
        `video_daily ${insert ? "insert" : "cleanup"}: ${from} through ${through}, aid ${last}`,
      );
      after = last;
    }
  } finally {
    if (cursorOpen) await pg.query("CLOSE manual_daily_aids");
  }
  return completeDays;
}

// The caller owns the PG connection; the worker holds the shared sync lock.
// Source history is assumed append-only: rows are only ever added for the
// current business date, so a verified past date cannot gain rows afterwards.
export async function backfillVideoDaily(
  pg: PoolClient,
  options: {
    startDate: string;
    endDate: string;
    schema: string;
    today: string;
    size: number;
    keepSource?: boolean;
    onProgress?: (message: string) => void;
  },
): Promise<void> {
  const { startDate, endDate, schema, today, size, onProgress } = options;
  validateAidBatchSize(size);
  const ctx: WindowContext = {
    pg,
    target: `${identifier(schema)}.video_daily`,
    sourceTable: `${identifier(schema)}.mysql_video_daily`,
    size,
    onProgress,
  };
  const { target, sourceTable } = ctx;
  const lockSql = (fn: string) =>
    `SELECT ${fn}(hashtextextended($1 || '.video_daily_mysql_sync', 0)) AS locked`;
  let locked = false;
  let source: Awaited<ReturnType<typeof videoDailySource>> | undefined;
  const phase = <T>(name: string, work: () => Promise<T>) =>
    timed(onProgress, name, work);
  try {
    await phase("sync lock", async () => {
      const attempt = await pg.query<{ locked: boolean }>(
        lockSql("pg_try_advisory_lock"),
        [schema],
      );
      if (!attempt.rows[0]?.locked) {
        onProgress?.(
          "video_daily sync lock: held by another sync, waiting for it to finish",
        );
        await pg.query(lockSql("pg_advisory_lock"), [schema]);
      }
      locked = true;
    });
    if (!options.keepSource) source = await videoDailySource(pg, schema);
    const remote = source;
    async function cleanWindow(from: string, through: string) {
      const completeDays = await syncWindow(ctx, from, through, false);
      await deleteComplete(completeDays, from, through);
    }
    // Check every aid before deleting complete dates in one native statement;
    // incomplete gaps must remain untouched.
    async function deleteComplete(
      completeDays: Map<string, boolean>,
      from: string,
      through: string,
    ) {
      const completeDates = [...completeDays]
        .filter(([date, complete]) => complete && date < today)
        .map(([date]) => date)
        .sort();
      if (!completeDates.length || !remote) return;
      const deleted = await phase(
        `delete complete dates ${completeDates.join(", ")} (window ${from} through ${through})`,
        () => remote.deleteDates(completeDates, today),
      );
      onProgress?.(
        `video_daily cleanup: deleted ${deleted} source rows for complete dates ${completeDates.join(", ")}`,
      );
    }
    if (!options.keepSource) {
      const cleanupWindows = await phase("find cleanup chunks", () =>
        pg.query<{ start: string; finish: string }>(
          `SELECT greatest((range_start AT TIME ZONE 'UTC')::date, $2::date)::text AS start,
           least((range_end AT TIME ZONE 'UTC')::date - 1, $3::date)::text AS finish
         FROM timescaledb_information.chunks
         WHERE hypertable_schema = $1 AND hypertable_name = 'video_daily'
           AND (range_end AT TIME ZONE 'UTC')::date > $2::date
           AND (range_start AT TIME ZONE 'UTC')::date <= $3::date
         ORDER BY range_start`,
          [schema, startDate, endDate],
        ),
      );
      for (const window of cleanupWindows.rows)
        await cleanWindow(window.start, window.finish);
    }
    let from = startDate;
    while (from <= endDate) {
      const first = await phase(
        `find first source row ${from} through ${endDate}`,
        () =>
          pg.query(
            `SELECT record_date::text,aid::text,coin,favorite,danmaku,"view",reply,share,"like" FROM ${sourceTable} WHERE record_date >= $1::date AND record_date <= $2::date ORDER BY ${sourceTable}.record_date,${sourceTable}.aid LIMIT 1`,
            [from, endDate],
          ),
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
      const completeDays = await syncWindow(
        ctx,
        from,
        through,
        true,
        chunk.is_compressed ? chunk.name : undefined,
      );
      if (options.keepSource) {
        const incompleteDates = [...completeDays]
          .filter(([, complete]) => !complete)
          .map(([date]) => date)
          .sort();
        if (incompleteDates.length)
          throw new Error(
            `video_daily incomplete target coverage for dates ${incompleteDates.join(", ")}; source retained`,
          );
      } else {
        await deleteComplete(completeDays, from, through);
      }
      from = addDays(through, 1);
    }
    if (options.keepSource)
      onProgress?.(
        `video_daily copy completed for ${startDate} through ${endDate}; source retained; coverage checks keys only, existing PG values preserved`,
      );
  } finally {
    try {
      await source?.close();
    } finally {
      if (locked) await pg.query(lockSql("pg_advisory_unlock"), [schema]);
    }
  }
}
