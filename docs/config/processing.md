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
See [Whitelist configuration](./whitelist.md) for the allowlists and migration.
