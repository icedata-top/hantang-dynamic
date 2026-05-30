# Adaptive Minute V1 Preflight

Branch: `dev-adaptive-minute-v1`

## Scope

This preflight records the current repository facts needed before implementing
the adaptive minute V1 plan. It only verifies local code and schema definitions.

## Verified Facts

1. The current worktree started from a detached HEAD and now runs on
   `dev-adaptive-minute-v1`.
2. `src/database/index.ts` exposes the existing `Database` singleton and
   `getPool()` advanced access path.
3. `Database.init()` builds one `pg.Pool`, sets `search_path` from
   `config.database.schema`, and calls `initializeSchema()`.
4. `src/database/schema/index.ts` registers existing schema initializers in the
   shared initialization path.
5. `video_daily` has `record_date`, `aid`, `coin`, `favorite`, `danmaku`,
   `view`, `reply`, `share`, and `like`, with index
   `idx_video_daily_aid_date` on `(aid, record_date ASC)`.
6. `video_daily_latest` has primary key `aid`, latest `record_date`, stats
   fields, and `updated_at`.
7. `video_minute` has `time`, `aid`, stats fields, and index
   `idx_video_minute_aid_time` on `(aid, time ASC)`.
8. The local `video_minute` table has no `bvid` column. V1 must not write
   `bvid`.
9. `src/api/video.ts` defines `fetchVideoFullDetail()` with endpoint
   `/view/detail`. It remains a detail/fallback path, not the planned minute
   stats main path.
10. `src/utils/rateLimiter.ts` implements a concurrency-slot `RateLimiter`.
11. `processed_videos` currently contains `tid_v2`, `is_deleted`,
    `is_filtered`, `pubdate`, and `ctime`.
12. `processed_videos` currently does not define `label_content_type`,
    `label_origin`, or `labeled_by`. SQL that integrates with future
    `icedata_label` output must tolerate missing label columns and use the
    temporary `tid_v2` fallback until those columns exist.

## Risks Found

1. `src/index.ts` logs the parsed config object at debug level. That can expose
   database URLs and Bilibili credentials.
2. `src/api/client.ts` includes `JSON.stringify(response.config)` in API error
   notifications. That can expose Cookie headers and request credentials.
3. `src/api/video.ts` logs full direct fallback URLs on detail failures. The
   current detail URL only includes ids, but the error object passed alongside
   it can still include request config.

## Phase 1 Boundary

Phase 1 should add the V1 config, collection state schema, queue schema,
crossing history, and SQL functions through the existing schema initialization
path. It should also add a shared redaction utility before minute high-frequency
code uses the API path.
