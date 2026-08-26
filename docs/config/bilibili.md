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
account and provision its independent Watch Later state. This feature runs only
when `[minute].enabled = true`. Minute sampling and Watch Later management start
together; management runs immediately and then every 15 minutes.

Each available enabled account contributes 1,000 slots. The global target gives
60% of those slots to positive-priority videos, then gives the remaining 40% to
the newest eligible processed videos. It is distributed deterministically
across the available enabled accounts without assigning a video to more than
one account.

Enabled accounts are dedicated Watch Later lists. Reconciliation can delete
non-target entries, including manually added entries, and add assigned target
entries. Each account uses one lease and a fresh complete snapshot, with
non-target entries deleted before missing targets are added. Mutation POSTs are
paced at least one second apart globally.

An account that fails snapshot retrieval or validation, authentication,
mutation, or To View sampling is disabled for the current process run. Other
accounts continue. Lease acquisition or renewal contention skips that account
for the current management cycle so a later cycle can retry it. Affected video
coverage uses the favorite-resource fallback in `[minute].batch_size` batches,
which default to 50 AIDs. Restarting the process checks disabled accounts again
and recomputes the distribution. Environment cookie paths remain
authentication-only and do not enable Watch Later.

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
