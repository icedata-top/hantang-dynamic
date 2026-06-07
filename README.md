# Bilibili Dynamic Subscribe

A tool to track, filter, and export Bilibili video updates from your following
list and recommended videos.

See [Changelog](./changelog.md) for version history.

## Key Features

- **Streaming Processing**: Efficiently handles large feeds with low memory
  usage.
- **Smart Caching**: Uses PostgreSQL to cache video details and forwarded dynamics,
  minimizing API calls.
- **Retrospective Analysis**: Automatically scans historical data to fill gaps.
- **Recommendation Discovery**: Discovers new content and UP hosts via video
  recommendations.
- **Robust Storage**: Stores all data in PostgreSQL database for easy
  analysis.
- **Concurrency Control**: Built-in rate limiting and proxy support.

## Installation

### 1. Pre-built Executables

1. Download the executable for your platform from the latest GitHub Release.
2. Make the file executable (Linux/macOS only):
   ```bash
   chmod +x bilibili-dynamic-subscribe-linux
   ```
3. Create your configuration file:
   ```bash
   cp config.toml.example config.toml
   ```
4. Edit `config.toml` with your settings.
5. Initialize or upgrade database schema once:
   ```bash
   ./bilibili-dynamic-subscribe-linux --init-schema
   ```
6. Run the executable:
   ```bash
   ./bilibili-dynamic-subscribe-linux
   ```

### 2. From Source

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Initialize or upgrade database schema once
pnpm init-schema

# Start
pnpm start
```

`pnpm init-schema` runs database DDL. Run it during install or upgrade only.
Normal startup and restarts do not create or alter database objects.

## Configuration

The application is configured via `config.toml`. Key sections include:

- **[bilibili]**: Authentication (UID, SessData or Cookie File).
- **[database]**: PostgreSQL connection URL.
- **[metrics]**: Optional Prometheus `/metrics` endpoint.
- **[application]**: Execution settings (interval, concurrency, history).
- **[processing]**: Filter rules and feature flags (recommendations).

### Cookie File Support

Instead of configuring `sessdata` directly, you can use a Netscape-format cookie
file (e.g., exported from browser extensions like "Cookie-Editor"):

```toml
[bilibili]
uid = "12345678"
cookie_file = "./.cookies.txt"  # Path to Netscape cookie file
```

### Prometheus Metrics

Metrics are disabled by default. Enable the shared HTTP listener and the
built-in Prometheus scrape endpoint with `[server]` and `[metrics]` blocks or
environment variables:

```toml
[server]
enabled = true
host = "127.0.0.1"
port = 9469
# auth_token = "change-me"

[metrics]
enabled = true
path = "/metrics"
collect_default_metrics = true
```

Equivalent environment variables are `SERVER_ENABLED`, `SERVER_HOST`,
`SERVER_PORT`, `SERVER_AUTH_TOKEN`, `METRICS_ENABLED`, `METRICS_PATH`, and
`METRICS_COLLECT_DEFAULT`. Older `METRICS_HOST`, `METRICS_PORT`, and
`METRICS_AUTH_TOKEN` values are still accepted as listener fallbacks. When
`server.auth_token` is set, scrape requests must include `Authorization: Bearer
<token>`.

The endpoint exports process metrics plus application metrics with the
`bili_tracker_` prefix for fetch cycles, Bilibili API latency and errors, rate
limiter depth, PostgreSQL query and pool state, adaptive minute sampling,
notifications, exports, and fatal exit reasons.

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: bili-tracker
    scrape_interval: 30s
    static_configs:
      - targets: ["127.0.0.1:9469"]
```

An example Grafana dashboard is available at
[`examples/grafana/bili-tracker-dashboard.json`](./examples/grafana/bili-tracker-dashboard.json).
Import it into Grafana and select your Prometheus datasource.

Metric interpretation notes:

- Bilibili video unavailable responses such as deleted or hidden videos are
  treated as normal business outcomes, not API transport errors.
- When a proxy is configured, a failed proxied API request followed by a direct
  fallback is counted as two API request samples with different `host` labels.

### Repair API

The shared HTTP listener can also expose repair control endpoints when
`repair.api_enabled = true` or `REPAIR_API_ENABLED=true`. Repair requests
rewrite stored video data and call Bilibili APIs, so they require
`server.auth_token`; if no token is configured, the repair API returns `403`.

```toml
[repair]
api_enabled = true
path = "/repair"
status_path = "/repair/status"
max_bvids = 1000
```

Start a repair job for specific videos:

```bash
curl -X POST http://127.0.0.1:9469/repair \
  -H "Authorization: Bearer $SERVER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bvids":["BV1xx411c7mD"]}'
```

Supported JSON fields are:

- `bvid`: one BV id to repair.
- `bvids`: up to 1000 BV ids to repair.
- `all`: repair every stored video when set to `true`.
- `filter`: structured selection over stored `processed_videos`.
- `fixAids`: repair aid/bvid mismatches before processing videos.

Filter example:

```bash
curl -X POST http://127.0.0.1:9469/repair \
  -H "Authorization: Bearer $SERVER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"columns":{"user_id":{"in":["123456"]},"type_id":{"in":[28,30]},"is_filtered":true,"is_deleted":false,"dynamic":{"isNull":false},"updated_at":{"gte":"2026-06-01T00:00:00Z"}},"limit":100}}'
```

`filter.columns` supports all `processed_videos` columns: `aid`, `bvid`,
`pubdate`, `title`, `description`, `tag`, `pic`, `type_id`, `user_id`,
`is_filtered`, `created_at`, `updated_at`, `staff`, `tid_v2`, `dynamic`,
`tag_new`, `participle`, `ctime`, `is_deleted`, `copyright`, `extras`, and
`notes`.

Column filters accept direct equality values or operation objects. Supported
operations are:

- `isNull`: `true` becomes `IS NULL`; `false` becomes `IS NOT NULL`.
- `eq` and `in`: exact match for scalar columns.
- `min`, `max`, `gt`, `gte`, `lt`, `lte`: number and timestamp comparisons.
- `contains`: `ILIKE` for text columns, `@>` for JSONB, overlap for arrays.
- `hasAny`, `hasAll`, `isEmpty`: array columns.

Legacy aliases remain accepted for convenience: `bvids`, `userIds`, `typeIds`,
`isFiltered`, `isDeleted`, `createdAfter`, `createdBefore`, `updatedAfter`,
`updatedBefore`, `pubdateAfter`, and `pubdateBefore`. The API builds
parameterized SQL from those fields; raw SQL filters remain CLI-only.

Only one repair job can run at a time. Check the current or most recent job:

```bash
curl http://127.0.0.1:9469/repair/status \
  -H "Authorization: Bearer $SERVER_AUTH_TOKEN"
```

## Development

```bash
# use pnpm to install dependencies
pnpm install

# Run in development mode
pnpm dev

# Lint code
pnpm lint

# Format code
pnpm format

# Package executables
pnpm package
```

Release tag builds automatically derive the application version from tags named
`vX.Y.Z`. The workflow updates `package.json` and `src/version.ts` in the
runner before checking and packaging, so release artifacts report the tag
version without a separate source change.

Thanks a lot for the
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
project.
