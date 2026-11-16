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
| `tid_v2` | `processed_videos.tid_v2` | Decides when the video has a non-zero `tid_v2`. |
| `pid_v2` | `processed_videos.pid_v2` | Does not decide monitoring. Only pre-selects which related-video cards get their details fetched. |
| `tid_v1` | `processed_videos.type_id` (the legacy tid) | Stand-in while `tid_v2` is unknown. |

A video qualifies when its `tid_v2` is listed under `tid_v2`. A `tid_v2` of `0`
(or none) means unknown, and `pid_v2` plays no part. The legacy tid is always
present but less reliable, so it only decides while `tid_v2` is unknown: a
`tid_v1` match then admits the video. Once a non-zero `tid_v2` arrives, it alone
decides and a v1 match no longer counts. That is how a video admitted on a wrong
v1 value gets corrected. A v1 mismatch never removes a video; only a `tid_v2`
verdict does.
`whitelist.video.type_ids`, which also filters which videos are stored at all,
seeds the `tid_v1` list once (see below). Later changes to that key do not
change the table.

`pnpm init-schema` creates the table and seeds it once from
`whitelist.video.type_ids` (the `tid_v1` values), the deprecated
`whitelist.minute_bootstrap.tid_v2` (default `[2022, 2061, 4215]`) and
`whitelist.recommendation.pid_v2` (default `[]`) values. Later runs never
re-seed, so a value you delete stays deleted.

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
| A non-zero `tid_v2` is whitelisted | The video enters `video_collection_state` (bootstrap if new, daily-driven if it has history). |
| A non-zero `tid_v2` is not whitelisted | A monitored video is pulled out: priority `-1`, `monitor_source = 'whitelist_excluded'`, unless its source protects it (below). A video never monitored gets no row. |
| `tid_v2` is `0` or missing, and `type_id` is listed under `tid_v1` | The video enters monitoring until a non-zero `tid_v2` arrives. |
| `tid_v2` is `0` or missing, and `type_id` is not listed | Left alone, whatever its `pid_v2`. |
| A fetch omits `tid_v2` | The stored value is kept, so a missing field never changes the result. |
| Deleted, or filtered out | Disabled as before, and not revived by the whitelist. |

Only rows the whitelist itself excluded (`monitor_source = 'whitelist_excluded'`)
can come back, and only when the whitelist later admits them. Rows disabled for
other reasons stay disabled.

### Formal labels come before the whitelist

If an external classifier has added `label_content_type`, `label_origin` and
`labeled_by` to `processed_videos`, the trigger and
`fn_reevaluate_collection_whitelist` pass a row's label on when all three are
set. Without those columns, or with only some of them set, the label counts as
absent and the whitelist decides. Nothing in this schema adds the columns.

| Complete label | Result |
| --- | --- |
| Passes (`whitelist.minute_bootstrap.label_content_types`, `label_origin`, `label_writers`) | Admitted or kept with `monitor_source = 'label'`, whatever the whitelist says. |
| Does not pass | Demoted to priority `-1` with no source, which is final, unless its source protects it (below). A video never monitored gets no row. |

Changing only the label columns does not fire the trigger. Re-evaluate the
affected videos afterwards to apply the new labels.

### Which rows are protected

| `monitor_source` | Pulled out by a `tid_v2` mismatch? | Demoted by a failing label? |
| --- | --- | --- |
| `whitelist`, `whitelist_excluded` | Yes | Yes |
| `label` | No | Yes |
| `manual` | No | No: reported as `label_demotion_blocked_protected` |
| `daily` | No: reported as `pull_out_blocked_protected` | No: reported as `label_demotion_blocked_protected` |
| none (written before this column existed) | No: reported as `pull_out_blocked_protected` | No: reported as `label_demotion_blocked_protected` |

A protected row is left exactly as it is. A row you insert into
`video_collection_state` by hand gets `manual` automatically, because that is
the column default; the application's own inserts always name their source
(`whitelist`, `label` or `daily`). When the whitelist or a passing label admits a
row with no source or the `daily` source, the row takes the source `whitelist`
or `label`, and from then on it is no longer protected.

To give up the protection for a reviewed set of rows, either change their
source to `whitelist`:

```sql
UPDATE video_collection_state SET monitor_source = 'whitelist'
WHERE aid = ANY(ARRAY[1, 2, 3]::bigint[]);
```

or evaluate them inside a transaction that sets the release settings. Each
setting only lasts until the end of its transaction, and the trigger never sets
them:

```sql
BEGIN;
SET LOCAL hantang.allow_pull_legacy = on;     -- tid_v2 mismatch may pull out rows with no source or 'daily'
SET LOCAL hantang.allow_label_demotion = on;  -- a failing label may demote rows with no source, 'daily' or 'manual'
SELECT * FROM fn_reevaluate_collection_whitelist(ARRAY[1, 2, 3]::bigint[]);
COMMIT;
```

None of this keeps a deleted video, or one filtered out by the content filters,
from being disabled.

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
