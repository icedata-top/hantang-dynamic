# Changelog

## 5.4.0

Repair mode is faster and easier to monitor. Proxy-backed repairs can request multiple detail batches in parallel, report live progress, and avoid unrelated recommendation or owner side effects while rewriting stored video records.

- Added `repair.batch_concurrency` and `REPAIR_BATCH_CONCURRENCY` to control parallel proxy detail batch requests.
- Exposed live repair progress from the repair status API, including totals, success, skip, error, batch progress, rate, elapsed time, and ETA.
- Split proxy repairs into 50-item chunks and runs chunks concurrently while keeping per-video database processing bounded by the application concurrency limit.
- Falls back only the failed proxy chunk to single-video repair, so one failed batch no longer abandons the rest of the repair run.
- Disables recommendation traversal, related-video processing, and owner storage during repair processing to reduce write amplification.
- Documented the new batch concurrency setting in the README and example config.

## 5.3.2

- Handles proxy HTML 404 responses in repair batch detail fetches as deleted item responses.
- Falls back per failed repair chunk instead of abandoning the full batch repair path.
- Adds an index for expiring bootstrap collection rows.
- Reduces idle subtitle polling by sleeping longer when no subtitle job is pending.

## 5.3.1

- Corrects manual and AI subtitle classification by using subtitle track type fields instead of the old AI-type signal.
- Replaces the pending subtitle index with ordering that handles missing view counts.
- Removes the runtime subtitle state row gauge query to keep metrics collection lighter.

## 5.3.0

Adds subtitle collection, storage, state tracking, and metrics for eligible videos.

- Adds `[subtitle]` configuration and a `video_subtitles` storage table.
- Adds subtitle state columns to `video_collection_state` and a migration for marking already eligible videos pending.
- Starts a single subtitle service from the first configured account and stores subtitle body, plain text, style metadata, and terminal state.
- Classifies subtitle outcomes as manual, partial manual, AI-only, no subtitle, skipped, or retrying.
- Lets gate crossings and view thresholds move videos into pending subtitle collection.

## 5.2.1

- Adds repair-only proxy batch fetching for video detail data through the configured API proxy.
- Shares detail extraction between batch repair and single-video repair so owners, related videos, deleted states, unavailable states, and filtering stay consistent.
- Keeps batch detail fetching out of the normal tracker path.

## 5.2.0

Adds a protected repair control API and separates HTTP listener concerns from feature-specific configuration.

- Splits listener and auth settings into `[server]`, Prometheus behavior into `[metrics]`, and repair controls into `[repair]`.
- Adds protected `POST /repair` and `GET /repair/status` endpoints with single-job tracking.
- Validates repair requests with structured JSON, `max_bvids`, and typed filters over known `processed_videos` columns.
- Builds repair filters as parameterized SQL instead of accepting ad hoc raw conditions.
- Refines minute priority behavior with bidirectional adaptive priority and tighter near-gate criteria.

## 5.1.0

Adds optional Prometheus observability for the main runtime, API, database, minute loop, exporters, and notifications.

- Adds `[metrics]` configuration and an optional `/metrics` HTTP server.
- Registers build info, process metrics, API latency/error metrics, tracker cycle metrics, database query/pool metrics, minute batch metrics, notification metrics, export metrics, and fatal-exit counters.
- Updates notification senders to surface failures so metrics can classify channel success and error results.

## 5.0.7

- Adds a 75-second floor for priority-1 polling to match Bilibili counter refresh behavior.
- Reworks near-gate detection and normal scheduling so delayed batches do not cascade.
- Skips ahead after outages instead of creating catch-up storms.

## 5.0.6

- Adds minute batch accumulation for non-gate videos.
- Flushes accumulated minute samples on full batch, timeout, or near-gate video arrival.
- Carries `near_gate` and `due_at` through due selection so next-sleep logic only considers future due times.

## 5.0.5

- Simplifies `video_minute` bulk inserts by deduping incoming `(aid, time)` samples inside the batch.
- Removes the previous cross-table existence lookup from the insert path.
- Ignores local `.pnpm-store/` artifacts.

## 5.0.4

- Fixes PostgreSQL `search_path` initialization by passing startup options to the pool.
- Avoids the previous asynchronous connect-hook race during pool startup.

## 5.0.3

- Reworks adaptive minute collection from queue claim and acknowledgement tasks into a queue-free, state-driven sleep loop.
- Adds migration guidance for abandoning or purging old queue work and backfilling `next_gate_value`.
- Removes queue and tick configuration knobs that are no longer needed when scheduling comes from `video_collection_state`.

## 5.0.2

- Skips forwarded dynamics cleanly when the original dynamic returns HTTP 404.
- Keeps one unavailable forward from failing the whole forward resolution path.

## 5.0.1

- Optimizes minute and gate schema functions, indexes, cleanup paths, SQL helpers, and schema initialization ordering.
- Tightens daily candidate selection around today, yesterday, and seven-day snapshots.
- Expands history tracking so filtered state is captured alongside video history.

## 5.0.0

Introduces adaptive minute-level collection and makes schema changes an explicit install or upgrade step.

- Adds disabled-by-default `[minute]` configuration, `--init-schema`, gate-crossing tracking, minute sample inserts, and the minute runtime loop.
- Adds `video_collection_state` and the original queue-backed minute collection schema.
- Stops running database DDL during normal tracker startup; schema initialization is now opt-in.
- Adds shared API rate limiting.
- Redacts sensitive config and runtime values in logs.

## 4.0.0

Rebuilds the application around PostgreSQL-backed storage and streaming service layers.

- Adds PostgreSQL schema modules for videos, dynamics, users, recommendations, time-series stats, and in-database BV/AV conversion functions.
- Splits runtime work into streaming dynamics fetches and detail-processing services, with cache checks before expensive API calls.
- Adds Netscape cookie-file support with cookie-jar persistence.
- Adds retrospective scans, per-type dynamic watermarks, following-status sync, repair mode, and CSV import tooling.
- Adds recommendation discovery, concurrency control, proxy settings, and richer README/config guidance.

## 3.0.0

Moves the project from environment-variable driven configuration to TOML and schema-validated runtime sections.

- Adds `config.toml` support with Bilibili, application, processing, export, and notification sections.
- Adds HTTP webhook notifications with templated URL, headers, params, and request body support.
- Adds MySQL-backed deduplication helpers for dynamics and processed video data.
- Splits video filtering and card processing into dedicated utilities.
- Switches linting and formatting to Biome.

## 2.12.2

- Adds video detail API wrappers for view, full detail, archive description, and page-list endpoints.
- Adds typed response models for detailed video metadata, rights, stats, pages, dimensions, descriptions, and page lists.

## 2.12.1

- Changes CSV export to merge new rows into the existing file by BVID instead of overwriting it.
- Fixes DuckDB timestamp conversion to use microsecond-scale timestamps.

## 2.12.0

Adds the authenticated API signing and failure handling needed for newer Bilibili endpoints.

- Adds BiliTicket generation, persistence, and renewal during client/tracker startup.
- Adds WBI key fetching, cached WBI state, and request signing helpers.
- Adds fatal handling for cookie expiry, risk-control failures, and IP bans.
- Renames content filtering config to blacklist and whitelist arrays.
- Lets whitelist terms bypass type filtering.

## 2.11.0

- Replaces the follow-only script with a relation manager for follow, unfollow, block, unblock, and remove-follower operations.
- Adds interactive and key-value CLI argument handling for relation management.
- Expands relation API handling with browser-visit simulation, API error mapping, idempotent success handling, and batch fallbacks.

## 2.10.0

- Adds keyword blacklist filtering across title, description, and fetched tags.
- Adds `CONTENT_BLACKLIST` configuration and example environment entry.

## 2.9.0

- Adds relation APIs for following, blocking, and fetching current follows behind relation feature configuration.
- Adds a batch follow script for tab-delimited user CSVs, existing-follow checks, and delayed batches.
- Adds deeper error stack logging and ignores generated `data/` output.

## 2.8.5

- Ignores generated `data/` output in git.
- Logs error stacks in API and state paths to improve debugging.

## 2.8.4

- Zips downloaded platform artifacts before publishing release assets.
- Limits published release assets to generated zip files.

## 2.8.3

- Moves release-action update and generated release notes options into action inputs.
- Leaves runtime code unchanged.

## 2.8.2

- Reworks CI packaging into a platform matrix for Windows, Linux x64, Linux arm64, and macOS arm64.
- Generates platform-specific start scripts inside release artifacts instead of tracking static scripts.

## 2.8.1

- Updates release artifacts to include DuckDB native runtime files.
- Documents storage path settings and normalizes example environment values.

## 2.8.0

- Adds DuckDB export and writes successful batches to DuckDB and CSV while keeping MySQL optional.
- Adds configurable CSV and DuckDB output paths.
- Raises the TypeScript target to ES2020 for BigInt support.

## 2.7.5

- Converts large Bilibili identifiers in dynamic and video types to `bigint`.
- Splits exporters and notifiers into dedicated CSV, MySQL, Telegram, and email modules.

## 2.7.4

- Adds configurable log levels through `LOGLEVEL`.
- Routes API, tracker, and startup logs through the shared logger instead of direct console calls.

## 2.7.3

- Replaces `ts-node` development/start scripts with `tsx`.
- Moves dynamic filtering, forward resolution, deduplication, and card processing out of the tracker into a dedicated helper.

## 2.7.2

- Refactors dynamic processing out of the tracker so forward handling, filtering, and export decisions share one helper path.

## 2.7.1

- Fixes the random User-Agent runtime import path for the ESM package.

## 2.7.0

- Adds email notification support with SMTP host, port, sender, and recipient settings.
- Adds persisted random User-Agent state and sends it on Bilibili API requests.
- Updates README and example environment settings for release-based installation and email configuration.

## 2.6.3

- Adds random User-Agent rotation to reduce repeated identical Bilibili requests.

## 2.6.2

- Fixes dynamic pagination by starting each type from the latest endpoint before walking history.
- Allows release action updates in the workflow and bumps the package version.

## 2.6.1

- Grants the build workflow release-write permission so tagged builds can publish artifacts.
- Leaves runtime code unchanged.

## 2.6.0

- Adds support for video and forwarded dynamic fetch types, including original video resolution for forwards.
- Adds a release packaging workflow that builds platform artifacts and release zips.
- Keeps type filtering, MySQL export, Telegram notification, tag fetch, and max-item support in the release tree.

## 2.5.0

- Adds `MAX_ITEM` to cap the number of fetched dynamics per run.
- Wires the limit into dynamic fetching and tracker processing.

## 2.4.1

- Removes the Docker build path from the release flow.

## 2.4.0

- Adds Telegram notification support for API and runtime messages.
- Adds Telegram bot token and chat ID configuration.

## 2.3.1

- Fixes Bilibili card handling in the bundled build path.

## 2.3.0

- Switches production bundling to `@vercel/ncc`.
- Updates package and build scripts for bundled executable packaging.

## 2.2.1

- Changes MySQL inserts to ignore duplicate videos instead of failing.
- Keeps batched insertion into the configured MySQL table.

## 2.2.0

- Adds optional MySQL export alongside CSV output.
- Adds MySQL connection and table settings to configuration docs.

## 2.1.0

- Adds type ID filtering so only selected Bilibili video categories are exported.
- Documents `TYPE_ID_WHITE_LIST` configuration.

## 2.0.0

Reworks the app into a TypeScript tracker with separate API, config/state, service, and utility layers.

- Adds persisted dynamic state so polling can resume from the last processed dynamic.
- Keeps CSV export as the baseline output path.
