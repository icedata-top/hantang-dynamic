# Bilibili Dynamic Subscribe

A tool to track and export Bilibili video updates.

## Installation

Choose one of these installation methods:

### 1. Pre-built Executables

1. Download the executable for your platform from the latest GitHub Actions artifacts:

   - `bilibili-dynamic-subscribe-linux` for Linux
   - `bilibili-dynamic-subscribe-win.exe` for Windows
   - `bilibili-dynamic-subscribe-macos` for macOS

2. Make the file executable (Linux/macOS only):
   ```bash
   chmod +x bilibili-dynamic-subscribe-linux
   ```

### 2. Docker(Coming Soon)

Pull and run the latest Docker image:

```bash
docker pull ghcr.io/icedata-top/hantang-dynamic:latest
docker run -v ./config.env:/app/.env ghcr.io/icedata-top/hantang-dynamic:latest
```

### 3. From Source

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Start
pnpm start
```

## Configuration

Create a

.env file in the same directory as the executable with your settings:

```env
# Required Settings
SESSDATA = ""                # Your Bilibili session data
BILIBILI_UID = ""                    # Your Bilibili user ID

# Optional Settings
FETCH_INTERVAL = 900000     # Fetch interval in ms (default: 15 minutes)
API_WAIT_TIME = 2000        # Wait time between API calls (default: 2000ms)
API_RETRY_TIMES = 3         # Number of API retry attempts (default: 3)
MAX_HISTORY_DAYS = 7        # Maximum days of history to fetch (default: 7)
ENABLE_TAG_FETCH = "true"   # Whether to fetch video tags (default: false)

# Video Type Filtering
TYPE_ID_WHITE_LIST = 28,30,130  # Comma-separated video type IDs
                                # 28: Original Music
                                # 30: VOCALOID
                                # 130: Music Misc

# MySQL Export Settings (Optional)
MYSQL_IP = ""              # MySQL server IP
MYSQL_PORT = 3306          # MySQL server port
MYSQL_USERNAME = ""        # MySQL username
MYSQL_PASSWORD = ""        # MySQL password
MYSQL_DATABASE = ""        # MySQL database name
MYSQL_TABLE = ""          # MySQL table name
```

## Development

```bash
# Run in development mode
pnpm dev

# Lint code
pnpm lint

# Format code
pnpm format

# Package executables
pnpm package
```
