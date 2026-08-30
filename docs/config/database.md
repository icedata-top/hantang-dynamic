# Database Configuration

`[database]` configures PostgreSQL.

```toml
[database]
url = "postgresql://localhost:5432/hantang"
schema = "public"
```

## Fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `DATABASE_URL` | `postgresql://localhost:5432/hantang` | PostgreSQL connection URL. |
| `schema` | `DATABASE_SCHEMA` | `public` | PostgreSQL schema used as `search_path`. |

## Schema initialization

Normal startup does not create or alter database objects. Run schema
initialization explicitly during install or upgrade:

```bash
pnpm init-schema
```

or with an executable:

```bash
./bilibili-dynamic-subscribe-linux --init-schema
```

This command runs DDL. Use it only when you intend to install or upgrade schema
objects.

The schema command leaves historical `processed_videos.mission_id` values
nullable. To populate valid values already present in `extras`, run the optional
maintenance command after schema initialization:

```bash
pnpm backfill-mission-ids
```

or with an executable:

```bash
./bilibili-dynamic-subscribe-linux --backfill-mission-ids
```

The command commits updates in batches of 10,000. It is safe to interrupt and
rerun because each pass selects only rows whose `mission_id` is still null.
