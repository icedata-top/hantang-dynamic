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

Metrics are disabled by default. Enable the built-in Prometheus scrape endpoint
with a `[metrics]` block or environment variables:

```toml
[metrics]
enabled = true
host = "127.0.0.1"
port = 9469
path = "/metrics"
collect_default_metrics = true
# auth_token = "change-me"
```

When `auth_token` is set, scrape requests must include
`Authorization: Bearer <token>`. The endpoint exports process metrics plus
application metrics with the `bili_tracker_` prefix for fetch cycles, Bilibili
API latency and errors, rate limiter depth, PostgreSQL query and pool state,
adaptive minute sampling, notifications, exports, and fatal exit reasons.

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: bili-tracker
    scrape_interval: 30s
    static_configs:
      - targets: ["127.0.0.1:9469"]
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

Thanks a lot for the
[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
project.
