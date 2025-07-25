# Bilibili Dynamic Subscribe

A tool to track and export Bilibili video updates.

See [Changelog](./changelog.md) for version history.

## Installation

Choose one of these installation methods:

### 1. Pre-built Executables

1. Download the executable for your platform from the latest GitHub Release:

2. Make the file executable (Linux/macOS only):

   ```bash
   chmod +x bilibili-dynamic-subscribe-linux
   ```

3. Create your configuration file:

   ```bash
   cp config.toml.example config.toml
   ```

4. Edit the `config.toml` file with your settings.

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

Create a `config.toml` file in the same directory as the executable. You can use the provided `config.toml.example` as a template.

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

Thanks a lot for the [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) project.
