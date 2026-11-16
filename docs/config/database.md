# Database Configuration

`[database]` configures PostgreSQL.

```toml
[database]
url = "postgresql://localhost:5432/hantang"
schema = "public"
pool_size = 20
```

## Fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `DATABASE_URL` | `postgresql://localhost:5432/hantang` | PostgreSQL connection URL. |
| `schema` | `DATABASE_SCHEMA` | `public` | PostgreSQL schema used as `search_path`. |
| `pool_size` | `DATABASE_POOL_SIZE` | `20` | Maximum pooled PostgreSQL connections. Keep it at or below the server's `max_connections` budget, leaving headroom for other clients. |

## Pruning the MySQL source

The MySQL `video_daily` table is append-only and only this project deletes from
it. The nightly `sync_video_daily_from_mysql` cron job copies every source date
and then runs `TRUNCATE` on the `mysql_video_daily` foreign table. It truncates
only when:

- every source row has a `record_date`;
- every date's target row count is at least the number of source keys staged
  for it; and
- the source row count is unchanged from the snapshot taken before copying.

If rows were appended during the copy, the job repeats the copy up to three
passes and otherwise keeps the source until the next run. Rows appended between
the final count and the `TRUNCATE` itself cannot be detected, so schedule the
job away from the writer.

Requirements: `mysql_fdw` with `TRUNCATE` support (PostgreSQL 14+, foreign
table not marked `truncatable 'false'`) and a MySQL user that may empty the
table. Re-run `pnpm init-schema` to install the updated job.

The pool belongs to one process and is shared by every tracked account, so the
budget is per process rather than per account. Size it for the busiest account
count you run (`pool_size` should be at least the number of accounts multiplied
by their effective page concurrency) and leave the server's `max_connections`
budget room for other clients.

## Schema initialization

Normal startup does not create or alter database objects. Run schema
initialization explicitly during install or upgrade:

```bash
pnpm init-schema
```

or with an executable:

```bash
./bilibili-dynamic-subscribe-linux --init-schema
```

This command runs DDL. Use it only when you intend to install or upgrade schema
objects.

The schema command leaves historical `processed_videos.mission_id` values
nullable. To populate valid values already present in `extras`, run the optional
maintenance command after schema initialization:

```bash
pnpm backfill-mission-ids
```

or with an executable:

```bash
./bilibili-dynamic-subscribe-linux --backfill-mission-ids
```

The command commits updates in batches of 10,000. It is safe to interrupt and
rerun because each pass selects only rows whose `mission_id` is still null.

## Monitoring whitelist

Which videos are minute-monitored, and which related videos are admitted, is
decided by the table `collection_whitelist`, not by TOML. It has one row per
listed value:

| `kind` | Matched against | Role |
| --- | --- | --- |
| `tid_v2` | `processed_videos.tid_v2` | Authoritative when the video has a `tid_v2`. |
| `pid_v2` | `processed_videos.pid_v2` | Authoritative when the video has a `pid_v2`. Also admits related videos. |
| `tid_v1` | `processed_videos.type_id` (the legacy tid) | Stand-in until a `tid_v2` or `pid_v2` is known. |

A video qualifies when its `tid_v2` is listed under `tid_v2` **or** its `pid_v2`
is listed under `pid_v2`. The legacy tid is always present but less reliable, so
it only decides while the video has neither a `tid_v2` nor a `pid_v2`: a
`tid_v1` match then admits it. Once either v2 value arrives, v2 alone decides and
a v1 match no longer counts. That is how a video admitted on a wrong v1 value
gets corrected. A v1 mismatch never removes a video; only a v2 verdict does.
`tid_v1` is separate from `whitelist.video.type_ids`, which filters which videos
are stored at all.

`pnpm init-schema` creates the table and seeds it once from the deprecated
`whitelist.minute_bootstrap.tid_v2` (default `[2022, 2061]`) and
`whitelist.recommendation.pid_v2` (default `[]`) values. `tid_v1` starts empty.
Later runs never re-seed, so a value you delete stays deleted.

```sql
INSERT INTO collection_whitelist (kind, value) VALUES ('pid_v2', 1234)
ON CONFLICT DO NOTHING;
INSERT INTO collection_whitelist (kind, value) VALUES ('tid_v1', 30)
ON CONFLICT DO NOTHING;
DELETE FROM collection_whitelist WHERE kind = 'tid_v2' AND value = 2061;
```

### What the trigger does

A trigger on `processed_videos` re-evaluates a video when it is inserted, and
when its `type_id`, `tid_v2`, `pid_v2`, `is_filtered` or `is_deleted` changes.
The application no longer writes monitoring state itself.

| Situation | Result |
| --- | --- |
| `tid_v2` or `pid_v2` is whitelisted | The video enters `video_collection_state` (bootstrap if new, daily-driven if it has history). |
| It has a `tid_v2` or `pid_v2`, but neither is whitelisted | A monitored video is pulled out: priority `-1`, `monitor_source = 'whitelist_excluded'`. A video never monitored gets no row. |
| It has neither v2 value, and `type_id` is listed under `tid_v1` | The video enters monitoring until a v2 value arrives. |
| It has neither v2 value, and `type_id` is not listed | Left alone. |
| A fetch omits `tid_v2` or `pid_v2` | The stored value is kept, so a missing field never changes the result. |
| Deleted, or filtered out | Disabled as before, and not revived by the whitelist. |

Only rows the whitelist itself excluded (`monitor_source = 'whitelist_excluded'`)
can come back, and only when the whitelist later admits them. Rows disabled for
other reasons stay disabled.

### Manually added videos

The whitelist never pulls out a row whose `monitor_source` is `manual` or
`label`. A row you insert into `video_collection_state` by hand gets `manual`
automatically, because that is the column default; the application's own inserts
always name their source (`whitelist`, `label` or `daily`). Rows written before
this column existed have no source and are treated as ordinary, so they can be
pulled out. Pin the ones you want to keep **before** running the re-evaluation
below:

```sql
UPDATE video_collection_state SET monitor_source = 'manual'
WHERE aid = ANY(ARRAY[1, 2, 3]::bigint[]);
```

`manual` protects against the whitelist only. A video that is deleted, or
filtered out by the content filters, is still disabled.

### Applying a whitelist change to stored videos

The trigger only reacts to future changes. After editing `collection_whitelist`,
or once after upgrading, apply it to stored videos on demand:

```sql
SELECT * FROM fn_reevaluate_collection_whitelist();
-- or a batch:
SELECT * FROM fn_reevaluate_collection_whitelist(ARRAY[1, 2, 3]::bigint[]);
```

It returns one row per outcome (for example `disabled_not_whitelisted`,
`revived_upserted_bootstrap`, `ignored_not_whitelisted`) with a video count. The
full run is a single statement over `processed_videos`; on a large table, pass
`p_aids` in batches.

Run `pnpm init-schema` before upgrading the application: the app reads
`collection_whitelist` at runtime and the trigger is installed by the schema.
