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
affected videos afterwards to apply the new labels (dry run first, see
[Applying a whitelist change to stored videos](#applying-a-whitelist-change-to-stored-videos)).

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

or re-evaluate them with the release switches of `pnpm reevaluate-collection`
(`--allow-pull-legacy`, `--allow-label-demotion`; dry-run them first, see
below). By hand, the same is a transaction that sets the release settings. Each
setting only lasts until the end of its transaction, and the trigger never sets
them:

```sql
BEGIN;
SET LOCAL hantang.allow_pull_legacy = on;     -- tid_v2 mismatch may pull out rows with no source or 'daily'
SET LOCAL hantang.allow_label_demotion = on;  -- a failing label may demote rows with no source, 'daily' or 'manual'
SELECT * FROM fn_reevaluate_collection_whitelist(ARRAY[1, 2, 3]::bigint[]);
COMMIT;
```

Only ever use `SET LOCAL` inside such a transaction. Never set these settings
for a session (`SET`), a role or the database (`ALTER ROLE/DATABASE ... SET`):
the trigger reads them too, so every write in that scope would drop the
protection.

None of this keeps a deleted video, or one filtered out by the content filters,
from being disabled.

### Applying a whitelist change to stored videos

`pnpm init-schema` seeds `collection_whitelist` from the configuration only
when it first creates the table; from then on the table is the only list.
Neither `init-schema`, application start nor the trigger re-evaluates videos
that are already stored: the trigger only reacts to new videos and to changes
of a video's `type_id`, `tid_v2`, `pid_v2`, `is_filtered` or `is_deleted`. A
whitelist edit or a label-only change reaches stored videos only through the
steps below, which are always run by hand.

1. Edit the table:

   ```sql
   BEGIN;
   INSERT INTO collection_whitelist (kind, value)
   SELECT 'tid_v2', unnest(ARRAY[2016, 2021, 2022, 2023, 2061])
   ON CONFLICT DO NOTHING;
   DELETE FROM collection_whitelist
   WHERE kind = 'tid_v2' AND value <> ALL (ARRAY[2016, 2021, 2022, 2023, 2061]);
   COMMIT;
   ```

   To compare candidate lists before touching the table, skip this step and
   pass them to the dry run instead (`--tid-v2`, `--tid-v1`).

2. Dry-run the videos you intend to change. Nothing is written:

   ```bash
   pnpm reevaluate-collection --active-only
   pnpm reevaluate-collection --from-aid 1 --to-aid 500000 --details dry-run.csv
   pnpm reevaluate-collection --active-only --tid-v2 2016,2021,2022,2023,2061 --tid-v1 28,30,47,59,130,244
   ```

   or with an executable: `./bilibili-dynamic-subscribe-linux --reevaluate-collection --active-only`.

3. Apply the reviewed range in batches, keeping the pre-image file:

   ```bash
   pnpm reevaluate-collection --active-only --apply --pre-image before-1.jsonl
   ```

4. If the result is wrong, put the saved rows back:

   ```bash
   pnpm reevaluate-collection --restore before-1.jsonl            # preview
   pnpm reevaluate-collection --restore before-1.jsonl --apply
   ```

A range is required. Give `--from-aid`/`--to-aid` (inclusive), `--aids-file`
(aids separated by whitespace or commas), `--active-only` (videos whose state
priority is above 0), or `--all` for every stored video. Without one the
command exits with an error and does nothing. `--from-aid`/`--to-aid` also
narrow the other three.

| Option | Default | Meaning |
| --- | --- | --- |
| `--apply` | off | Write. Without it the run is a dry run. |
| `--pre-image <file>` | — | Required with `--apply`. Appends each batch's state rows (whole rows, or `null` when a video has none) before the batch is written. |
| `--batch <n>` | `5000` | Videos per batch; each batch is one transaction. |
| `--max-batches <n>` | all | Stop after this many batches. |
| `--statement-timeout`, `--lock-timeout` | `60s`, `5s` | Set for each batch's transaction. |
| `--tid-v2 a,b`, `--tid-v1 a,b` | `collection_whitelist` | Dry run only: the lists to evaluate against. Required where the table does not exist yet. |
| `--exact-daily-history` | off | Dry run only: look up `video_daily` for each batch instead of approximating (see below). |
| `--details <file>` | — | Write one CSV line for every evaluated video. |
| `--allow-pull-legacy`, `--allow-label-demotion` | off | Release the protection (see above) for the evaluated videos: as `SET LOCAL` inside each `--apply` batch, and in the dry run's verdicts. |
| `--restore <file>` | — | Restore a pre-image file; a preview unless `--apply` is given. |

The dry run runs every batch in a read-only transaction. It evaluates the same
decision expression the trigger uses, inlined into a plain query, so it does
not need `collection_whitelist`, the `monitor_source` column or any function of
this schema: it also runs on a database that has not been upgraded yet, and
with `default_transaction_read_only = on`. Label rules and the new-video age
come from the configuration and are printed with the report; make sure they
match what `init-schema` installed. Whether a video has daily history only
decides how an admitted video enters (from daily data or as bootstrap or
backfill). By default the dry run approximates it with the state row's
`last_daily_record_date` and says so in the report; `--exact-daily-history`
reads `video_daily` once per batch instead, which is slower on a large table.

The report prints the outcome counts, the counts by outcome, current priority
(`>0`, `0`, `-1`, `-2`, `none`) and current `monitor_source`, by `tid_v2` (by
`type_id` while `tid_v2` is 0 or NULL) and by `label_content_type`, and lists
every video with priority above 0. Without `--details` it also lists every
video that leaves, enters or is held by the protection. Each listed video shows
`aid, tid_v2, type_id, pid_v2`, the label columns, the current priority and
source, the `basis` that decided (`label`, `v2`, or `v1` while `tid_v2` is
unknown), the raw `decision` and the `outcome`:

| Outcome | Meaning |
| --- | --- |
| `keep_active` | Already has a state row and keeps it. |
| `newly_admit_bootstrap`, `newly_admit_backfill`, `newly_admit_daily` | Enters monitoring on its `tid_v2` (new video, older video, or from daily data). |
| `v2_unknown_v1_admit` | Enters monitoring on its `type_id` while `tid_v2` is unknown. |
| `v2_unknown_no_v1` | `tid_v2` unknown and `type_id` not listed: left alone. |
| `label_admit` | A passing label admits or keeps it. |
| `revive` | A whitelist exclusion that the whitelist now admits again. |
| `pull_out` | Leaves monitoring: `tid_v2` not listed. |
| `pull_out_blocked_protected` | Would leave monitoring, but its source protects it. |
| `label_demotion` | Leaves monitoring for good: its label fails. |
| `label_demotion_blocked_protected` | Would be demoted, but its source protects it. |
| `disable_deleted`, `disable_filtered_out` | Disabled because the video is deleted or filtered out. |
| `unchanged_disabled` | Already disabled and stays so. |
| `no_row_not_admitted` | Has no state row and does not get one. |
| `label_not_ready` | A partial label reached the decision. Never expected here; a self-check. |

`--apply` processes the range in `aid` order. Each batch locks its state rows,
appends them to the pre-image file, re-evaluates every video with
`fn_reevaluate_collection_whitelist`, which reads the video again right before
evaluating it, and commits. After each batch the command prints the next
`--from-aid`; if a run stops, by `--max-batches` or an error (the failed batch
is rolled back), rerun the same command with that `--from-aid`. Use a new
pre-image file per run, or keep appending to the same one: restore uses the
first entry of each aid. Restore writes the saved rows back column by column
and deletes rows that did not exist before. It does not undo
`video_collection_gate_crossings` rows that the daily refresh records while
admitting a video, and it overwrites anything the application changed in those
rows after the apply, such as the next minute due time.

`fn_reevaluate_collection_whitelist(p_aids)` is the same evaluation for a given
set of videos. It returns one row per outcome (for example
`disabled_not_whitelisted`, `new_upserted_bootstrap`,
`revived_upserted_bootstrap`), where `new_` marks a video that had no state
row. Called without arguments it evaluates every stored video in one statement
and one transaction; use the batched command instead.

To roll back the schema of this version itself, keep a `pg_get_functiondef`
copy of the previous `fn_upsert_collection_state_from_processed_video`
before upgrading. Rolling back means re-creating that definition and dropping
the triggers `trg_processed_video_collection_state` and
`trg_processed_video_collection_state_update` on `processed_videos`; do it by
hand, there is no command for it.

Run `pnpm init-schema` before upgrading the application: the app reads
`collection_whitelist` at runtime and the trigger is installed by the schema.
