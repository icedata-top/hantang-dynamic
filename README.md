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

Create a `config.toml` file in the same directory as the executable. The TOML format is much cleaner and more organized than `.env` files:

```toml
# Data flow: Input → Processing → Output

[input.bilibili]
# Required: Your Bilibili user ID and session data
uid = "12345678"               # Your Bilibili user ID
sessdata = "your_sessdata"     # Your Bilibili session data

# Optional: Additional authentication tokens
csrf_token = ""                # CSRF token for user relation operations
access_key = ""                # Access key for app authentication

[input.application]
# Application input behavior settings
log_level = "info"             # Log level: debug, info, warn, error
fetch_interval = 900000        # Fetch interval in milliseconds (15 minutes)
api_retry_times = 3            # Number of API retry attempts
api_wait_time = 2000           # Wait time between API calls in milliseconds
max_history_days = 7           # Maximum days of history to fetch
max_item = 0                   # Maximum number of items to fetch (0 for unlimited)

[processing.features]
# Feature toggles
enable_tag_fetch = false       # Whether to fetch video tags
enable_user_relation = false  # Toggle for user relation features

[processing.filtering]
# Content filtering settings
type_id_whitelist = [28, 30, 130]  # Video type IDs to include
                                   # 28 = Original Music, 30 = VOCALOID, 130 = Music Misc
content_blacklist = []             # Content blacklist keywords
content_whitelist = []             # Content whitelist keywords

[processing.deduplication]
# AIDS tracking for deduplication
aids_duckdb_path = ""          # AIDS tracking DuckDB (auto-generated if empty)

[output.csv]
# CSV file export settings
path = ""                      # CSV file path (auto-generated if empty)

[output.duckdb]
# DuckDB file export settings
path = ""                      # DuckDB file path (auto-generated if empty)

[output.database]
# MySQL export settings (all optional)
host = ""                      # MySQL server IP
port = 3306                    # MySQL server port
username = ""                  # MySQL username
password = ""                  # MySQL password
database = ""                  # MySQL database name
table = ""                     # MySQL table name

[output.notifications.telegram]
# Telegram notification settings
bot_token = ""                 # Telegram bot token
chat_id = ""                   # Telegram chat ID

[output.notifications.email]
# Email notification settings
host = ""                      # SMTP server host (e.g., "smtp.gmail.com")
port = 587                     # SMTP server port
username = ""                  # Email username
password = ""                  # Email password
from = ""                      # Sender email address
to = ""                        # Recipient email address
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

Thanks a lot for the [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) project.
