# Database Configuration

`[database]` configures PostgreSQL.

```toml
[database]
url = "postgresql://localhost:5432/hantang"
schema = "public"
pool_size = 20
prune_video_daily_source = false
```

## Fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `DATABASE_URL` | `postgresql://localhost:5432/hantang` | PostgreSQL connection URL. |
| `schema` | `DATABASE_SCHEMA` | `public` | PostgreSQL schema used as `search_path`. |
| `pool_size` | `DATABASE_POOL_SIZE` | `20` | Maximum pooled PostgreSQL connections. Keep it at or below the server's `max_connections` budget, leaving headroom for other clients. |
| `prune_video_daily_source` | `DATABASE_PRUNE_VIDEO_DAILY_SOURCE` | `false` | Let the nightly `sync_video_daily_from_mysql` cron job truncate the MySQL `video_daily` table after copying it. See below. |

## Pruning the MySQL source

The MySQL `video_daily` table is append-only and only this project deletes from
it. When `prune_video_daily_source` is enabled, the nightly cron job copies
every source date (not just the last three days) and then runs
`TRUNCATE` on the `mysql_video_daily` foreign table. It truncates only when:

- no source row lacks a `record_date`;
- every date's target row count is at least the number of source keys staged
  for it; and
- the source row count is unchanged from the snapshot taken before copying.

If rows were appended during the copy, the job repeats the copy up to three
passes and otherwise keeps the source until the next run. Rows appended between
the final count and the `TRUNCATE` itself cannot be detected, so schedule the
job away from the writer.

Requirements: `mysql_fdw` with `TRUNCATE` support (PostgreSQL 14+, foreign
table not marked `truncatable 'false'`) and a MySQL user that may drop the
table's rows. The cron command is fixed when the schema is initialized, so run
`pnpm init-schema` again after changing this setting.

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
