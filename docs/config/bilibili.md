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
  { path = "./.cookies_account1.txt", enable_watch_later = true },
  { path = "./.cookies_account2.txt", enable_watch_later = false },
]
```

When cookie files are used, the app extracts `uid` from the `DedeUserID` cookie.
Cookie-file authentication requires `DedeUserID`; that cookie is the account
identity. `enable_watch_later` defaults to `false`.

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

## Watch-later minute sampling

Set `enable_watch_later = true` on a cookie-file entry to sample that loaded
account and provision its independent watch-later state. The global production
capacity currently equals `0`, so enabled accounts make read-only To View GET
requests and send no mutation POSTs. Environment cookie paths remain
authentication-only and do not enable Watch Later.

`pnpm watch-later-empirical -- 60` is an explicitly invoked empirical mutation
run. The optional argument is the exclusive priority limit and defaults to
`30`.
It requires a database URL and exactly one successfully loaded cookie account
with `enable_watch_later = true`. It continues through eligible videos below
the selected priority limit in batches of ten, validates a complete snapshot
after each batch, and prints aggregate counts only. It is not limited by the
production capacity of `0`.

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

When both `cookie_files` and `cookie_file` are set, `cookie_files` is used.
`cookie_file` is the single-account fallback.

`cookie_files` previously accepted string paths. It now accepts only object
entries with `path` and `enable_watch_later`; convert each existing path to an
object entry during this public TOML migration.
