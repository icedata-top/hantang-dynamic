# Notifications Configuration

`[notifications]` contains Telegram, email, and HTTP notification settings.

## Telegram

```toml
[notifications.telegram]
enabled = false
new_video_enabled = true
warning_enabled = true
bot_token = ""
chat_id = ""
api_host = "api.telegram.org"
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `TELEGRAM_ENABLED` | `false` | Enable Telegram notifications. |
| `new_video_enabled` | `TELEGRAM_NEW_VIDEO_ENABLED` | `true` | Notify for new videos. |
| `warning_enabled` | `TELEGRAM_WARNING_ENABLED` | `true` | Notify for warnings and errors. |
| `bot_token` | `TELEGRAM_BOT_TOKEN` | none | Telegram bot token. |
| `chat_id` | `TELEGRAM_CHAT_ID` | none | Telegram chat ID. |
| `api_host` | `TELEGRAM_API_HOST` | `api.telegram.org` | Telegram API host. |

## Email

```toml
[notifications.email]
enabled = false
host = ""
port = 587
username = ""
password = ""
from = ""
to = ""
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `EMAIL_ENABLED` | `false` | Enable email notifications. |
| `host` | `EMAIL_HOST` | none | SMTP host. |
| `port` | `EMAIL_PORT` | none | SMTP port. |
| `username` | `EMAIL_USER` | none | SMTP username. |
| `password` | `EMAIL_PASS` | none | SMTP password. |
| `from` | `EMAIL_FROM` | none | Sender address. |
| `to` | `EMAIL_TO` | none | Recipient address. |

## HTTP

```toml
[notifications.http]
enabled = false
timeout = 5000
retries = 3
delay = 100

[notifications.http.headers]
# "Authorization" = "Bearer token"

[[notifications.http.endpoints]]
url = "https://api.example.com/webhook"
method = "POST"
headers = { "Content-Type" = "application/json" }
body = '''
{
  "message": "{{message}}",
  "aid": "{{aid}}",
  "bvid": "{{bvid}}"
}
'''
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `HTTP_ENABLED` | `false` | Enable HTTP notifications. |
| `endpoints` | `HTTP_ENDPOINTS` | `[]` | Endpoint list. |
| `timeout` | `HTTP_TIMEOUT` | `5000` | Request timeout in milliseconds. |
| `retries` | `HTTP_RETRIES` | `3` | Retry count. |
| `headers` | `HTTP_HEADERS` | `{}` | Global headers. |
| `delay` | `HTTP_DELAY` | `100` | Delay between notifications in milliseconds. |

`HTTP_ENDPOINTS` must be a JSON string when provided as an environment variable.

