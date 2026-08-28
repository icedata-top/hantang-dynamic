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
account and provision its independent Watch Later state. Each healthy enabled
account is assigned up to 980 items, leaving 20 slots below Bilibili's
1,000-item limit. The global target gives 60% of those assignments to
positive-priority videos, then gives the remaining 40% to the newest eligible
processed videos. It is distributed deterministically across the healthy
enabled accounts without assigning a video to more than one account.

Enabled accounts are dedicated Watch Later lists. Reconciliation can delete
non-target entries, including manually added entries, and add assigned target
entries. Only accounts whose complete snapshots are fetched and synchronized
enter the current cycle's healthy set. Videos not covered by a current healthy
snapshot use the existing favorite/history fallback in configured batches.
All enabled accounts are checked again and the distribution is recomputed in
the next cycle, which starts approximately every 15 minutes. Environment cookie
paths remain authentication-only and do not enable Watch Later.

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
