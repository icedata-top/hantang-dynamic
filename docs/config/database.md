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

