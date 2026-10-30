import mysql, { type Connection, type ResultSetHeader } from "mysql2/promise";
import type { PoolClient } from "pg";

const identifier = (value: string) => `\`${value.replace(/`/g, "``")}\``;
const optionsMap = (options: string[] | null) =>
  new Map(
    (options ?? []).map((option) => {
      const separator = option.indexOf("=");
      return [option.slice(0, separator), option.slice(separator + 1)];
    }),
  );

// Resolve the same table and current-role mapping used by mysql_fdw. The public
// view deliberately withholds credentials when the caller cannot read them.
export async function videoDailySource(pg: PoolClient, schema: string) {
  const result = await pg.query<{
    local_schema: string;
    local_table: string;
    fdw: string;
    server_options: string[] | null;
    table_options: string[] | null;
    mapping_id: number | null;
    mapping_options: string[] | null;
  }>(
    `SELECT n.nspname AS local_schema, c.relname AS local_table,
       w.fdwname AS fdw, s.srvoptions AS server_options,
       f.ftoptions AS table_options, m.umid AS mapping_id,
       m.umoptions AS mapping_options
     FROM pg_catalog.pg_foreign_table f
     JOIN pg_catalog.pg_class c ON c.oid = f.ftrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_foreign_server s ON s.oid = f.ftserver
     JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw
     LEFT JOIN LATERAL (
       SELECT umid, umoptions FROM pg_catalog.pg_user_mappings
       WHERE srvid = s.oid AND umuser IN (
         0, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       )
       ORDER BY (umuser <> 0) DESC LIMIT 1
     ) m ON true
     WHERE n.nspname = $1 AND c.relname = 'mysql_video_daily'`,
    [schema],
  );
  const metadata = result.rows[0];
  if (metadata?.fdw !== "mysql_fdw")
    throw new Error("mysql_video_daily must be a mysql_fdw foreign table");
  if (metadata.mapping_id === null)
    throw new Error("No mysql_fdw user mapping for current_user or PUBLIC");
  if (metadata.mapping_options === null)
    throw new Error(
      "mysql_fdw credentials are hidden by pg_user_mappings: reading your own mapping requires USAGE on the foreign server; reading a PUBLIC mapping requires server ownership or superuser privileges",
    );
  const server = optionsMap(metadata.server_options);
  const table = optionsMap(metadata.table_options);
  const mapping = optionsMap(metadata.mapping_options);
  // These paths belong to the PostgreSQL server, which may run in a different
  // container. Reading application-local files would not reproduce its target.
  for (const option of [
    "mysql_default_file",
    "ssl_key",
    "ssl_cert",
    "ssl_ca",
    "ssl_capath",
    "ssl_cipher",
  ]) {
    if (server.has(option))
      throw new Error(
        `Native source cleanup cannot reuse FDW option ${option}`,
      );
  }
  const host = server.get("host") ?? "127.0.0.1";
  if (!host || host === "localhost")
    throw new Error(
      "Native source cleanup requires an explicit TCP FDW host; localhost uses the PostgreSQL server's local MySQL socket",
    );
  const port = Number(server.get("port") ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid mysql_fdw source port");
  const user = mapping.get("username");
  if (!user)
    throw new Error(
      "Native source cleanup requires a username in the FDW user mapping",
    );
  const charset = server.get("character_set");
  if (charset === "PGDatabaseEncoding")
    throw new Error(
      "Native source cleanup cannot reuse FDW character_set PGDatabaseEncoding",
    );
  const source = `${identifier(table.get("dbname") ?? metadata.local_schema)}.${identifier(table.get("table_name") ?? metadata.local_table)}`;
  let connection: Connection | undefined;
  return {
    async deleteDates(dates: string[], today: string): Promise<number> {
      if (!dates.length) return 0;
      if (!connection) {
        connection = await mysql.createConnection({
          host,
          port,
          user,
          password: mapping.get("password"),
          database: table.get("dbname") ?? metadata.local_schema,
          ...(charset ? { charset } : {}),
        });
        try {
          const init = server.get("init_command");
          if (init) await connection.query(init);
          await connection.execute("SET SESSION sql_mode = ?", [
            server.get("sql_mode") ?? "ANSI_QUOTES",
          ]);
        } catch {
          // init_command can contain secrets; driver errors include its SQL.
          throw new Error(
            "Failed to initialize native mysql_fdw source session",
          );
        }
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `DELETE FROM ${source} WHERE record_date IN (${dates.map(() => "?").join(",")}) AND record_date < ?`,
        [...dates, today],
      );
      await connection.commit();
      return result.affectedRows;
    },
    async close(): Promise<void> {
      if (connection) await connection.end();
    },
  };
}
