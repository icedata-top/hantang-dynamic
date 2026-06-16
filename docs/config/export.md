# Export Configuration

`[export]` currently contains optional MySQL export settings.

```toml
[export]
[export.mysql]
enabled = false
host = ""
port = 3306
username = ""
password = ""
database = ""
table = ""
```

## MySQL fields

| TOML key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `MYSQL_ENABLED` | `false` | Enable MySQL export. |
| `host` | `MYSQL_IP` | none | MySQL host. |
| `port` | `MYSQL_PORT` | none | MySQL port. |
| `username` | `MYSQL_USERNAME` | none | MySQL user. |
| `password` | `MYSQL_PASSWORD` | none | MySQL password. |
| `database` | `MYSQL_DATABASE` | none | MySQL database. |
| `table` | `MYSQL_TABLE` | none | MySQL table. |

Leave MySQL export disabled unless all connection fields are configured.

