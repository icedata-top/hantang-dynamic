# Whitelist Configuration

All video, recommendation, and minute-bootstrap allowlists are configured under
`[whitelist]`. A non-empty TOML value takes precedence over the existing
environment variable; comma-separated environment list values are parsed into
arrays. Empty TOML arrays are explicit values and disable that list.

```toml
[whitelist.video]
type_ids = []
copyright_types = []
content_keywords = []

[whitelist.recommendation]
pid_v2 = []

[whitelist.minute_bootstrap]
label_content_types = ["vocaloid", "maybe_vocaloid"]
label_origin = "rule"
label_writers = ["classification_apply", "classification_trigger"]
tid_v2 = [2022, 2061]
```

| TOML key | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `whitelist.video.type_ids` | `TYPE_ID_WHITE_LIST` | `[]` | Video types admitted by the type check. |
| `whitelist.video.copyright_types` | `COPYRIGHT_WHITE_LIST` | `[]` | Copyright types admitted by the copyright check. |
| `whitelist.video.content_keywords` | `CONTENT_WHITE_LIST` | `[]` | Keywords that bypass the type and copyright checks. |
| `whitelist.recommendation.pid_v2` | `UPDATE_INFO_PID_V2_WHITELIST` | `[]` | Related videos admitted by recommendation collection and `--update-info`. |
| `whitelist.minute_bootstrap.label_content_types` | `MINUTE_BOOTSTRAP_LABEL_CONTENT_TYPES` | `["vocaloid", "maybe_vocaloid"]` | Label content types eligible for bootstrap. |
| `whitelist.minute_bootstrap.label_origin` | `MINUTE_BOOTSTRAP_LABEL_ORIGIN` | `rule` | Required label origin. |
| `whitelist.minute_bootstrap.label_writers` | `MINUTE_BOOTSTRAP_LABEL_WRITERS` | `["classification_apply", "classification_trigger"]` | Label writers eligible for bootstrap. |
| `whitelist.minute_bootstrap.tid_v2` | `MINUTE_BOOTSTRAP_TID_V2_ALLOWLIST` | `[2022, 2061]` | Fallback `tid_v2` values eligible for bootstrap when no formal label exists. |

An empty video type or copyright list disables that check. A matching content
keyword bypasses those checks, while `processing.filtering.content_blacklist`
still excludes matching videos. Recommendation admission requires a listed
`pid_v2`; `--update-info --pid-v2-whitelist` overrides the configured list for
that run. Minute bootstrap first uses formal label eligibility and uses `tid_v2`
only when formal label input is absent.

## Migrating existing TOML

Move each setting to its new key. The old TOML keys are no longer read:

| Old TOML key | New TOML key |
| --- | --- |
| `processing.filtering.type_id_whitelist` | `whitelist.video.type_ids` |
| `processing.filtering.copyright_whitelist` | `whitelist.video.copyright_types` |
| `processing.filtering.content_whitelist` | `whitelist.video.content_keywords` |
| `processing.filtering.pid_v2_whitelist` | `whitelist.recommendation.pid_v2` |
| `minute.bootstrap_label_content_types` | `whitelist.minute_bootstrap.label_content_types` |
| `minute.bootstrap_label_origin` | `whitelist.minute_bootstrap.label_origin` |
| `minute.bootstrap_label_writers` | `whitelist.minute_bootstrap.label_writers` |
| `minute.bootstrap_tid_v2_allowlist` | `whitelist.minute_bootstrap.tid_v2` |

Keep `processing.filtering.content_blacklist` where it is. Existing environment
variable names remain valid. After changing minute-bootstrap values, run
`pnpm init-schema` against the database so stored SQL function defaults use the
new values, then restart the application. Without schema initialization, calls
that rely on the stored SQL defaults can continue using the previously
installed bootstrap values.
