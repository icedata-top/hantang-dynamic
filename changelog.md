# Changelog

## 2.0

Refactor all code

## 2.1 Type ID Whitelist

Add type ID whitelist. Enable with environment variables.

```env
# Type ID Whitelist (Optional)
# Video Type Filtering
TYPE_ID_WHITE_LIST = 28,30,130  # Comma-separated video type IDs
                                # 28: Original Music
                                # 30: VOCALOID
                                # 130: Music Misc
```

## 2.2 MySQL Export

Enable MySQL export. Enable with environment variables.

```env
# MySQL Export Settings (Optional)
MYSQL_IP = ""              # MySQL server IP
MYSQL_PORT = 3306          # MySQL server port
MYSQL_USERNAME = ""        # MySQL username
MYSQL_PASSWORD = ""        # MySQL password
MYSQL_DATABASE = ""        # MySQL database name
MYSQL_TABLE = ""          # MySQL table name
```

## 2.2.1 MySQL Export Bug Fix, use INSERT IGNORE INTO

Fix MySQL export bug, use `INSERT IGNORE INTO` to avoid duplicate entries.

## 2.3 ncc build

Use `ncc` to build the project. Fix the output file size issue.

### 2.3.1 bilibili card bug fix

## 2.4 Telegram Notification Bot

Add Telegram notification bot. Enable with environment variables.

```env
# Telegram Bot Settings (Optional)
TELEGRAM_BOT_TOKEN = ""    # Telegram bot token
TELEGRAM_CHAT_ID = ""      # Telegram chat ID
```

### 2.4.1 Remove Docker Build

### 2.5 Add MAX_ITEM

Add `MAX_ITEM` environment variable to limit the number of items to be fetched.

```env
MAX_ITEM = 0                # Maximum number of items to fetch (0 for unlimited)
```

### 2.6 Add support for forwarded messages

Add support for forwarded messages. Enabled by default. No configuration required.

### 2.6.1 fix workflow

### 2.6.2 fix fetchDynamics logic
