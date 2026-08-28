# Bilibili Configuration

`[bilibili]` configures account authentication and optional API proxies.

## Required authentication

Use cookie files when possible:

```toml
[bilibili]
cookie_file = "./.cookies.txt"
```

For multiple authentication-only accounts, `cookie_files` accepts string paths:

```toml
[bilibili]
cookie_files = ["./.cookies_account1.txt", "./.cookies_account2.txt"]
```

Use object entries to configure Watch Later per account:

```toml
[bilibili]
cookie_files = [
  { path = "./.cookies_account1.txt", enable_watch_later = true },
  { path = "./.cookies_account2.txt", enable_watch_later = false },
]
```

The app uses a cookie file's numeric `DedeUserID` as the account identity. A
single `cookie_file`, or a one-entry `cookie_files` array, may instead use the
configured numeric `uid` when `DedeUserID` is absent. Every file in a
multi-account configuration must contain its own numeric `DedeUserID`.

String entries set `enable_watch_later` to `false`. Object entries can set it
explicitly; it also defaults to `false` when omitted.

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
account through To View and manage its Watch Later list. The supported topology
is one running application client for each database; that client may load
multiple Bilibili accounts. Each healthy enabled account is assigned up to 980
items, leaving 20 slots below Bilibili's 1,000-item limit. The global target
gives 60% of those assignments to positive-priority videos, then gives the
remaining 40% to the newest eligible processed videos. It is distributed
deterministically across the healthy enabled accounts without assigning a
video to more than one account.

Enabled accounts are dedicated Watch Later lists. Reconciliation can delete
non-target entries, including manually added entries, and add assigned target
entries. Only accounts whose complete, valid snapshots are fetched and
synchronized enter the current cycle's healthy set. If an account's To View
request later fails during minute sampling, it is removed from To View routing
until the next health scan. Videos not covered by a current healthy snapshot
use the existing favorite/history fallback in configured batches. All enabled
accounts are checked again and the distribution is recomputed in the next
cycle, which starts approximately every 15 minutes. Environment cookie paths
remain authentication-only and do not enable Watch Later.

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

`cookie_files` accepts string paths and object entries. Use the object form only
when an account needs `enable_watch_later` configuration.
