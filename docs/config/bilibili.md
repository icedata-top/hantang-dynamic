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
The `uid` setting is ignored in this mode.

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

`BILIBILI_COOKIE_FILES` is a comma-separated list.

