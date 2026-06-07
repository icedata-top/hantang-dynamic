# Adaptive Minute Collection Configuration

`[minute]` controls adaptive minute-level video collection. It is disabled by
default.

```toml
[minute]
enabled = false
consumer_tick_ms = 60000
claim_batch_size = 50
batch_size = 50
lock_duration_seconds = 30
max_attempts = 5
target_delta_per_sample = 100
target_delta_lower = 50
target_delta_upper = 200
min_positive_priority = 1
max_positive_priority = 720
bootstrap_priority = 10
bootstrap_ttl_hours = 24
bootstrap_label_content_types = ["vocaloid", "maybe_vocaloid"]
bootstrap_label_origin = "rule"
bootstrap_label_writers = ["classification_apply", "classification_trigger"]
bootstrap_tid_v2_allowlist = [2022, 2061]
weekly_zero_delta_days = 7
weekly_daily_priority = -2
minute_burst_delta_threshold = 500
minute_burst_priority = 1
processed_backfill_new_video_age_days = 7
gate_lead_time_minutes = 30
gate_min_lead_ratio = 0.10
gate_max_lead_views = 500
collection_business_timezone = "Asia/Shanghai"
```

## Enabling the collector

Set `enabled = true`:

```toml
[minute]
enabled = true
```

or set the environment variable when `config.toml` does not override it:

```powershell
$env:MINUTE_ENABLED = "true"
pnpm dev
```

The process starts `MinuteHandler` only when this flag is true.

## Collection path

Adaptive minute collection uses these tables and functions:

1. `video_collection_state` stores per-video collection state, priority, and
   next due time.
2. `fn_enqueue_video_collection_tasks()` creates due `minute` queue tasks from
   `video_collection_state`.
3. `video_collection_queue` stores pending, leased, completed, and abandoned
   collection tasks.
4. `MinuteHandler` claims queue tasks, samples video stats, inserts
   `video_minute`, and acknowledges task IDs.
5. The `video_minute` trigger updates `video_collection_state` after successful
   inserts.

`video_collection_state` is the center of scheduling state. It does not fetch
videos by itself. Queue creation happens when the minute handler is enabled and
ticks.

Daily inserts also refresh state through the `video_daily` trigger. This updates
priority and due time; it does not insert minute samples directly.

## Fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `MINUTE_ENABLED` | `false` | Start the minute handler. |
| `consumer_tick_ms` | `MINUTE_CONSUMER_TICK_MS` | `60000` | Handler tick interval in milliseconds. |
| `claim_batch_size` | `MINUTE_CLAIM_BATCH_SIZE` | `50` | Max queue tasks claimed per tick. |
| `batch_size` | `MINUTE_BATCH_SIZE` | `50` | Max AIDs sampled per stats API batch. |
| `lock_duration_seconds` | `MINUTE_LOCK_DURATION_SECONDS` | `30` | Queue lease duration. |
| `max_attempts` | `MINUTE_MAX_ATTEMPTS` | `5` | Attempts before abandoning a task. |
| `target_delta_per_sample` | `MINUTE_TARGET_DELTA_PER_SAMPLE` | `100` | Target view delta per sample. |
| `target_delta_lower` | `MINUTE_TARGET_DELTA_LOWER` | `50` | Lower clamp for target delta. |
| `target_delta_upper` | `MINUTE_TARGET_DELTA_UPPER` | `200` | Upper clamp for target delta. |
| `min_positive_priority` | `MINUTE_MIN_POSITIVE_PRIORITY` | `1` | Minimum positive interval in minutes. |
| `max_positive_priority` | `MINUTE_MAX_POSITIVE_PRIORITY` | `720` | Maximum positive interval in minutes. |
| `bootstrap_priority` | `MINUTE_BOOTSTRAP_PRIORITY` | `10` | Initial interval for newly tracked videos. |
| `bootstrap_ttl_hours` | `MINUTE_BOOTSTRAP_TTL_HOURS` | `24` | Maximum bootstrap window. |
| `bootstrap_label_content_types` | `MINUTE_BOOTSTRAP_LABEL_CONTENT_TYPES` | `["vocaloid", "maybe_vocaloid"]` | Label content types eligible for bootstrap. |
| `bootstrap_label_origin` | `MINUTE_BOOTSTRAP_LABEL_ORIGIN` | `rule` | Required label origin for bootstrap. |
| `bootstrap_label_writers` | `MINUTE_BOOTSTRAP_LABEL_WRITERS` | `["classification_apply", "classification_trigger"]` | Label writers eligible for bootstrap. |
| `bootstrap_tid_v2_allowlist` | `MINUTE_BOOTSTRAP_TID_V2_ALLOWLIST` | `[2022, 2061]` | Fallback type IDs eligible for bootstrap. |
| `weekly_zero_delta_days` | `MINUTE_WEEKLY_ZERO_DELTA_DAYS` | `7` | Weekly no-growth window. |
| `weekly_daily_priority` | `MINUTE_WEEKLY_DAILY_PRIORITY` | `-2` | Priority marker for weekly daily-only rows. |
| `minute_burst_delta_threshold` | `MINUTE_BURST_DELTA_THRESHOLD` | `500` | View delta that tightens minute interval. |
| `minute_burst_priority` | `MINUTE_BURST_PRIORITY` | `1` | Interval after burst detection. |
| `processed_backfill_new_video_age_days` | `MINUTE_PROCESSED_BACKFILL_NEW_VIDEO_AGE_DAYS` | `7` | Age cutoff for processed-video bootstrap. |
| `gate_lead_time_minutes` | `MINUTE_GATE_LEAD_TIME_MINUTES` | `30` | Lead window for gate prediction tasks. |
| `gate_min_lead_ratio` | `MINUTE_GATE_MIN_LEAD_RATIO` | `0.1` | Ratio for near-threshold gate tasks. |
| `gate_max_lead_views` | `MINUTE_GATE_MAX_LEAD_VIEWS` | `500` | Max view lead for near-threshold gate tasks. |
| `collection_business_timezone` | `MINUTE_COLLECTION_BUSINESS_TIMEZONE` | `Asia/Shanghai` | Business date timezone for daily refresh. |

Use TOML for array settings such as `bootstrap_label_content_types`,
`bootstrap_label_writers`, and `bootstrap_tid_v2_allowlist`. Unlike
`BILIBILI_COOKIE_FILES` and the processing filter lists, these minute array
settings are not parsed from comma-separated environment strings.

## Quick checks

Check whether the handler can create due queue tasks:

```sql
SELECT count(*) AS due_state_rows
FROM video_collection_state
WHERE priority > 0
  AND next_minute_due_at IS NOT NULL
  AND next_minute_due_at <= now();
```

Check whether queue tasks exist:

```sql
SELECT task_type, status, count(*) AS rows
FROM video_collection_queue
GROUP BY task_type, status
ORDER BY task_type, status;
```

Check recent minute writes:

```sql
SELECT aid, max("time") AS latest_minute_sample, count(*) AS sample_count
FROM video_minute
WHERE "time" >= now() - interval '6 hours'
GROUP BY aid
ORDER BY latest_minute_sample DESC
LIMIT 50;
```

If state rows are due but the queue stays empty, confirm that `enabled = true`
is active in the running process and that schema initialization has installed
the queue functions.
