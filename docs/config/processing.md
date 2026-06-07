# Processing Configuration

`[processing]` controls feature flags and filtering rules.

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
type_id_whitelist = []
copyright_whitelist = []
content_blacklist = []
content_whitelist = []
```

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `type_id_whitelist` | `TYPE_ID_WHITE_LIST` | `[]` | Type IDs to include. |
| `copyright_whitelist` | `COPYRIGHT_WHITE_LIST` | `[]` | Copyright types to include. |
| `content_blacklist` | `CONTENT_BLACK_LIST` | `[]` | Keywords to exclude. |
| `content_whitelist` | `CONTENT_WHITE_LIST` | `[]` | Keywords to include. |

For environment variables, list values are comma-separated.

