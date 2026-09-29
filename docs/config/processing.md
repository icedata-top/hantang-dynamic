# Processing Configuration

`[processing]` controls feature flags and the content blacklist. Video and
recommendation allowlists are configured under `[whitelist]`.

## Feature flags

```toml
[processing.features]
enable_tag_fetch = false
enable_user_relation = false
enable_deduplication = true
enable_recommendation = false
max_recommendation_depth = 1
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enable_tag_fetch` | `ENABLE_TAG_FETCH` | `false` | Fetch video tags. |
| `enable_user_relation` | `ENABLE_USER_RELATION` | `false` | Enable user relation features. |
| `enable_deduplication` | `ENABLE_DEDUPLICATION` | `true` | Deduplicate by AID. |
| `enable_recommendation` | `ENABLE_RECOMMENDATION` | `false` | Track recommendations. |
| `max_recommendation_depth` | `MAX_RECOMMENDATION_DEPTH` | `1` | Recommendation recursion depth. |

## Filtering

```toml
[processing.filtering]
content_blacklist = []
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `content_blacklist` | `CONTENT_BLACK_LIST` | `[]` | Keywords to exclude. |

For environment variables, list values are comma-separated. The blacklist is
applied after the video allowlists; matching an allowlist never bypasses it.

## Video and recommendation allowlists

Video and recommendation allowlists use these TOML keys. A TOML value takes
precedence over the corresponding environment variable; environment list values
are comma-separated. Empty TOML arrays explicitly disable a list.

```toml
[whitelist.video]
type_ids = []
copyright_types = []
content_keywords = []

[whitelist.recommendation]
pid_v2 = []
```

| TOML key | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `whitelist.video.type_ids` | `TYPE_ID_WHITE_LIST` | `[]` | Video types admitted by the type check. |
| `whitelist.video.copyright_types` | `COPYRIGHT_WHITE_LIST` | `[]` | Copyright types admitted by the copyright check. |
| `whitelist.video.content_keywords` | `CONTENT_WHITE_LIST` | `[]` | Keywords that bypass the type and copyright checks. Blank keywords are invalid. |
| `whitelist.recommendation.pid_v2` | `UPDATE_INFO_PID_V2_WHITELIST` | `[]` | Related videos admitted by recommendation collection and `--update-info`. |

An empty video type or copyright list disables that check. A matching content
keyword bypasses those checks, while `processing.filtering.content_blacklist`
still excludes matching videos. Recommendation admission requires a listed
`pid_v2`; `--update-info --pid-v2-whitelist` overrides the configured list for
that run.

Move these former TOML keys before starting the application:

| Former TOML key | Current TOML key |
| --- | --- |
| `processing.filtering.type_id_whitelist` | `whitelist.video.type_ids` |
| `processing.filtering.copyright_whitelist` | `whitelist.video.copyright_types` |
| `processing.filtering.content_whitelist` | `whitelist.video.content_keywords` |
| `processing.filtering.pid_v2_whitelist` | `whitelist.recommendation.pid_v2` |

Keep `processing.filtering.content_blacklist` where it is. Existing environment
variable names remain valid.
