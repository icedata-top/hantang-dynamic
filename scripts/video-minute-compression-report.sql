\set ON_ERROR_STOP on
\pset pager off

-- Read-only TimescaleDB compression report for the video_minute hypertable.
-- Run with:
--   psql "$DATABASE_URL" -f scripts/video-minute-compression-report.sql

\echo '== TimescaleDB version =='
SELECT extversion AS timescaledb_version
FROM pg_extension
WHERE extname = 'timescaledb';

\echo '== Hypertable storage =='
SELECT
  pg_size_pretty(table_bytes) AS table_size,
  pg_size_pretty(index_bytes) AS index_size,
  pg_size_pretty(toast_bytes) AS toast_size,
  pg_size_pretty(total_bytes) AS total_size,
  total_bytes
FROM hypertable_detailed_size('video_minute'::regclass);

\echo '== Compressed chunks and effective compression ratio =='
WITH raw_stats AS (
  SELECT to_jsonb(stats) AS value
  FROM hypertable_compression_stats('video_minute'::regclass) AS stats
), compression AS (
  SELECT
    COALESCE(sum((value ->> 'total_chunks')::bigint), 0) AS total_chunks,
    COALESCE(sum((value ->> 'number_compressed_chunks')::bigint), 0)
      AS compressed_chunks,
    COALESCE(sum((value ->> 'before_compression_total_bytes')::numeric), 0)
      AS before_bytes,
    COALESCE(sum((value ->> 'after_compression_total_bytes')::numeric), 0)
      AS after_bytes
  FROM raw_stats
)
SELECT
  total_chunks,
  compressed_chunks,
  pg_size_pretty(before_bytes::bigint) AS before_compression,
  pg_size_pretty(after_bytes::bigint) AS after_compression,
  round(before_bytes / NULLIF(after_bytes, 0), 2) AS compression_ratio,
  round(100 * (before_bytes - after_bytes) / NULLIF(before_bytes, 0), 2)
    AS space_saved_percent,
  before_bytes::bigint AS before_bytes,
  after_bytes::bigint AS after_bytes
FROM compression;

\echo '== Per-chunk compression ratio =='
WITH raw_stats AS (
  SELECT to_jsonb(stats) AS value
  FROM chunk_compression_stats('video_minute'::regclass) AS stats
), compression AS (
  SELECT
    value ->> 'chunk_schema' AS chunk_schema,
    value ->> 'chunk_name' AS chunk_name,
    value ->> 'compression_status' AS compression_status,
    COALESCE((value ->> 'before_compression_total_bytes')::numeric, 0)
      AS before_bytes,
    COALESCE((value ->> 'after_compression_total_bytes')::numeric, 0)
      AS after_bytes
  FROM raw_stats
)
SELECT
  c.range_start,
  c.range_end,
  compression.chunk_schema,
  compression.chunk_name,
  compression.compression_status,
  pg_size_pretty(compression.before_bytes::bigint) AS before_compression,
  pg_size_pretty(compression.after_bytes::bigint) AS after_compression,
  round(
    compression.before_bytes / NULLIF(compression.after_bytes, 0),
    2
  ) AS compression_ratio,
  round(
    100 * (compression.before_bytes - compression.after_bytes)
      / NULLIF(compression.before_bytes, 0),
    2
  ) AS space_saved_percent,
  compression.before_bytes::bigint AS before_bytes,
  compression.after_bytes::bigint AS after_bytes
FROM compression
LEFT JOIN timescaledb_information.chunks AS c
  ON c.chunk_schema = compression.chunk_schema
 AND c.chunk_name = compression.chunk_name
ORDER BY c.range_start NULLS LAST, compression.chunk_name;

\echo '== Compression policy and recent job results =='
SELECT
  jobs.job_id,
  jobs.proc_name,
  jobs.schedule_interval,
  jobs.config,
  jobs.scheduled,
  stats.next_start,
  stats.last_run_status,
  stats.last_successful_finish,
  stats.total_runs,
  stats.total_successes,
  stats.total_failures
FROM timescaledb_information.jobs AS jobs
LEFT JOIN timescaledb_information.job_stats AS stats
  ON stats.job_id = jobs.job_id
WHERE jobs.hypertable_schema = current_schema()
  AND jobs.hypertable_name = 'video_minute'
ORDER BY jobs.job_id;

-- Optional exact logical-row calculation. This scans and decompresses the
-- complete hypertable, so run it separately during a low-traffic window.
-- It combines the exact logical row count with the current total hypertable
-- size, including both hot uncompressed and historical compressed chunks.
--
-- WITH rows AS (
--   SELECT count(*)::numeric AS logical_rows
--   FROM video_minute
-- ), total AS (
--   SELECT sum(total_bytes)::numeric AS current_bytes
--   FROM hypertable_detailed_size('video_minute'::regclass)
-- )
-- SELECT
--   rows.logical_rows::bigint,
--   pg_size_pretty(total.current_bytes::bigint) AS current_hypertable_size,
--   round(total.current_bytes / NULLIF(rows.logical_rows, 0), 2)
--     AS current_bytes_per_logical_row
-- FROM rows
-- CROSS JOIN total;
