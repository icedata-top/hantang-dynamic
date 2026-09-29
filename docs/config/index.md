# Configuration Guide

The app reads configuration from `config.toml` first, then falls back to
environment variables when a TOML value is missing or empty. Defaults are applied
after that by the schema in `src/config/schemas`.

Start by copying the example file:

```bash
cp config.toml.example config.toml
```

Then fill only the sections you use. On startup, legacy whitelist TOML keys are
moved to `[whitelist.*]` automatically. Migration keeps a temporary backup
and replaces the file only after validating the migrated values. A conflicting
destination, quoted/dotted key, symlinked file needing migration, or
non-comment multiline string requires a manual edit. Invalid TOML produces a
warning and falls back to environment variables. Run migration when no other
process or editor is writing `config.toml`. If a process stops during migration
and leaves `config.toml.migration-lock`, remove that lock after confirming no
instance is migrating.

## Sections

- [Bilibili authentication and API](./bilibili.md)
- [Application runtime](./application.md)
- [Database](./database.md)
- [Adaptive minute collection](./minute.md)
- [Processing and filtering](./processing.md)
- [Export](./export.md)
- [Notifications](./notifications.md)

## Precedence

Each setting follows this order:

1. Non-empty value in `config.toml`
2. Environment variable
3. Schema default

This means a value in `config.toml` overrides the matching environment variable.
Remove the TOML value or leave it empty when you want the environment variable to
take effect.
