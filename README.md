# Bilibili Dynamic Subscribe

A tool to track, filter, and export Bilibili video updates from your following
list and recommended videos.

See [Changelog](./changelog.md) for version history.

## Key Features

- **Streaming Processing**: Efficiently handles large feeds with low memory
  usage.
- **Smart Caching**: Uses DuckDB to cache video details and forwarded dynamics,
  minimizing API calls.
- **Retrospective Analysis**: Automatically scans historical data to fill gaps.
- **Recommendation Discovery**: Discovers new content and UP hosts via video
  recommendations.
- **Robust Storage**: Stores all data in a local DuckDB database for easy
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
5. Run the executable:
   ```bash
   ./bilibili-dynamic-subscribe-linux
   ```

### 2. From Source

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Start
pnpm start
```

## Configuration

The application is configured via `config.toml`. Key sections include:

- **[bilibili]**: Authentication (UID, SessData).
- **[database]**: DuckDB storage path.
- **[application]**: Execution settings (interval, concurrency, history).
- **[processing]**: Filter rules and feature flags (recommendations).

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
