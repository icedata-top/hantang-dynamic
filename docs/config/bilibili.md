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

## QR onboarding

Create or renew an account without exporting cookies by hand:

```bash
pnpm login-qr [account] [--config config.toml]
```

The command prints a QR code and waits for the Bilibili app. If `account` is
omitted, it uses the logged-in profile name (falling back to the numeric uid);
if that uid already exists in a configured cookie file, that file is reused.
It then writes:

```text
./.cookies.<account>.txt
./.cookies.<account>.txt.refresh_token
```

It also adds the cookie file to `[bilibili]` in `config.toml`, converting
`cookie_file` to `cookie_files` when the account is added alongside another one.
Use `--no-config` to skip the config edit.

## Cookie refresh

Bilibili rotates `SESSDATA` and `bili_jct` through its passport cookie-refresh
flow. To let the app refresh an account automatically, put the browser
`localStorage` value `ac_time_value` in a sidecar file next to its cookie file:

```text
./.cookies_account1.txt            # cookies
./.cookies_account1.txt.refresh_token  # ac_time_value, one line
```

The sidecar is optional. When present, the app checks Bilibili every six hours
and reuses the official refresh flow when Bilibili reports `refresh: true`. New
cookies are written back to the cookie file and the rotated refresh token is
written to the sidecar. If the sidecar is absent or the refresh fails, the
account keeps using its current cookies.

`ac_time_value` is not part of the Netscape cookie file; copy it from the
devtools Local Storage entry for `https://www.bilibili.com`. It must come from
the same login session as the exported cookies.

The refresh is Bilibili's four-step passport flow:

1. `GET /x/passport-login/web/cookie/info` for `refresh` and the server timestamp
2. `GET https://www.bilibili.com/correspond/1/<RSA-OAEP correspondPath>` for `refresh_csrf`
3. `POST /x/passport-login/web/cookie/refresh` for new cookies and a new refresh token
4. `POST /x/passport-login/web/confirm/refresh` to invalidate the old token

The confirmation invalidates the old cookie/refresh-token pair. Do not keep using
the original browser session for the same account after the app rotates it, and
do not export the cookie file from a browser that is still actively visiting
Bilibili: either side rotating the pair makes the other copy stale.

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
until the next health scan. A `-702` response from To View or a Watch Later
mutation removes that account until the next 15-minute cycle retries it. If
that retry also returns `-702`, the account cools down for 30 minutes. Videos
not covered by a current healthy snapshot use the existing favorite/history
fallback in configured batches. All enabled
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
