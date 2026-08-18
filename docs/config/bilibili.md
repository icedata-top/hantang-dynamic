# Bilibili Configuration

`[bilibili]` configures account authentication and optional API proxies.

## Required authentication

Use cookie files when possible:

```toml
[bilibili]
cookie_file = "./.cookies.txt"
```

For multiple accounts, use `cookie_files`:

```toml
[bilibili]
cookie_files = [
  "./.cookies_account1.txt",
  "./.cookies_account2.txt",
]
```

When cookie files are used, the app extracts `uid` from the `DedeUserID` cookie.
If a cookie file does not contain `DedeUserID`, the app falls back to the
configured `uid`. Cookie-file authentication fails when neither source provides
an account UID.

Legacy direct `sessdata` mode requires `uid`:

```toml
[bilibili]
uid = "12345678"
sessdata = "..."
```

## Optional credentials

```toml
csrf_token = ""
access_key = ""
```

`csrf_token` maps to the `BILI_JCT` cookie and is needed for user relation
operations. `access_key` maps to app authentication.

`watch_later_test_account_id` selects one already authenticated account for the
manual `watch-later-empirical` script. The script adds up to ten eligible items
and verifies the snapshots, so leave this value unset unless running that
authorized empirical check.

## Watch-later minute sampling accounts

Configure normal sampling accounts explicitly. `capacity` is the only mutation
enablement value. It defaults to `0`, so changing it to a positive value alone
enables bounded additions for that account. `target_count` and optional
`remote_capacity` are independent per-account limits.

```toml
[bilibili]
watch_later_accounts = [
  { account_id = "12345678", capacity = 20, target_count = 20 },
]
```

Each `account_id` must match one configured authenticated account. Startup
creates or upgrades the required watch-later tables and provisions these rows;
manual SQL is not required. Existing configured rows removed from this list are
disabled by setting their capacity to `0`.

## Proxies

```toml
api_proxy_url = ""
dynamic_proxy_url = ""
```

`api_proxy_url` applies to general API calls. `dynamic_proxy_url` applies to
dynamic API calls.

## Environment variables

| TOML key | Environment variable | Default |
| --- | --- | --- |
| `uid` | `BILIBILI_UID` | none |
| `sessdata` | `SESSDATA` | none |
| `csrf_token` | `BILI_JCT` | none |
| `access_key` | `BILI_ACCESS_KEY` | none |
| `cookie_file` | `BILIBILI_COOKIE_FILE` | none |
| `cookie_files` | `BILIBILI_COOKIE_FILES` | none |
| `api_proxy_url` | `BILIBILI_API_PROXY_URL` | none |
| `dynamic_proxy_url` | `BILIBILI_DYNAMIC_PROXY_URL` | none |
| `watch_later_test_account_id` | `BILIBILI_WATCH_LATER_TEST_ACCOUNT_ID` | none |

`BILIBILI_COOKIE_FILES` is a comma-separated list.

When both `cookie_files` and `cookie_file` are set, `cookie_files` is used.
`cookie_file` is the single-account fallback.
