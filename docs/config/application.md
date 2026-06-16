# Application Configuration

`[application]` controls runtime behavior, rate limits, and retrospective scans.

```toml
[application]
log_level = "info"
fetch_interval = 900000
api_retry_times = 3
api_wait_time = 2000
max_history_days = 7
max_item = 0
concurrency_limit = 1
retrospective_interval = 604800000
retrospective_days = 30
```

## Fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `log_level` | `LOGLEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `fetch_interval` | `FETCH_INTERVAL` | `900000` | Main fetch interval in milliseconds. |
| `api_retry_times` | `API_RETRY_TIMES` | `3` | API retry count. |
| `api_wait_time` | `API_WAIT_TIME` | `2000` | Wait between API calls in milliseconds. |
| `max_history_days` | `MAX_HISTORY_DAYS` | `7` | Maximum historical days to fetch. |
| `max_item` | `MAX_ITEM` | `0` | Maximum feed items to fetch; `0` means unlimited. |
| `concurrency_limit` | `CONCURRENCY_LIMIT` | `1` | Concurrent API request limit. |
| `retrospective_interval` | `RETROSPECTIVE_INTERVAL` | `604800000` | Retrospective scan interval in milliseconds. |
| `retrospective_days` | `RETROSPECTIVE_DAYS` | `30` | Days to look back during retrospective scans. |

If `concurrency_limit` is not set and `api_proxy_url` is set, the default
concurrency becomes `20`; otherwise it is `1`.

