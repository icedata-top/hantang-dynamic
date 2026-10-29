import { type Connection, createConnection } from "mysql2/promise";
import type { PoolClient } from "pg";

const mysqlIdentifier = (value: string) => `\`${value.replace(/`/g, "``")}\``;

export async function resolveVideoDailySource(pg: PoolClient, schema: string) {
  const result = await pg.query<{
    fdw: string;
    server_encoding: string;
    database_name: string;
    table_name: string;
    server_options: Record<string, string>;
    table_options: Record<string, string>;
    mapping_options: Record<string, string> | null;
  }>(
    `SELECT w.fdwname AS fdw, current_setting('server_encoding') AS server_encoding,
       n.nspname AS database_name, c.relname AS table_name,
       COALESCE((SELECT jsonb_object_agg(option_name, option_value)
         FROM pg_options_to_table(s.srvoptions)), '{}'::jsonb) AS server_options,
       COALESCE((SELECT jsonb_object_agg(option_name, option_value)
         FROM pg_options_to_table(f.ftoptions)), '{}'::jsonb) AS table_options,
       (SELECT jsonb_object_agg(option_name, option_value)
         FROM pg_options_to_table(m.umoptions)) AS mapping_options
     FROM pg_foreign_table f
     JOIN pg_class c ON c.oid = f.ftrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_foreign_server s ON s.oid = f.ftserver
     JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw
     LEFT JOIN LATERAL (
       SELECT umoptions FROM pg_user_mappings
       WHERE srvid = s.oid AND (umuser = 0 OR umuser =
         (SELECT oid FROM pg_roles WHERE rolname = current_user))
       ORDER BY (umuser <> 0) DESC LIMIT 1
     ) m ON true
     WHERE n.nspname = $1 AND c.relname = 'mysql_video_daily'`,
    [schema],
  );
  const row = result.rows[0];
  if (row?.fdw !== "mysql_fdw")
    throw new Error(
      "Manual backfill requires the existing mysql_video_daily MySQL foreign table",
    );
  if (row.mapping_options?.username === undefined)
    throw new Error(
      "The current PostgreSQL role cannot read its MySQL FDW user mapping credentials",
    );
  const server = row.server_options;
  // These options refer to files on the PostgreSQL server, not this process.
  if (
    Object.keys(server).some(
      (name) => name === "mysql_default_file" || name.startsWith("ssl_"),
    )
  )
    throw new Error(
      "The MySQL FDW uses server-local connection files or TLS options that this worker cannot reuse",
    );
  const port = Number(server.port ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("The MySQL FDW port is invalid");
  const database = row.table_options.dbname ?? row.database_name;
  const table = row.table_options.table_name ?? row.table_name;
  const charset =
    server.character_set === "PGDatabaseEncoding"
      ? row.server_encoding
      : server.character_set;
  return {
    connection: {
      host: server.host ?? "127.0.0.1",
      port,
      user: row.mapping_options.username,
      password: row.mapping_options.password,
      database,
      ...(charset && charset !== "auto" ? { charset } : {}),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    },
    table: `${mysqlIdentifier(database)}.${mysqlIdentifier(table)}`,
    initCommand: server.init_command,
    sqlMode: server.sql_mode,
  };
}

export async function connectVideoDailySource(pg: PoolClient, schema: string) {
  const settings = await resolveVideoDailySource(pg, schema);
  const connection: Connection = await createConnection(settings.connection);
  try {
    if (settings.initCommand) await connection.query(settings.initCommand);
    if (settings.sqlMode !== undefined)
      await connection.execute("SET SESSION sql_mode = ?", [settings.sqlMode]);
    return { connection, table: settings.table };
  } catch (error) {
    await connection.end();
    throw error;
  }
}
