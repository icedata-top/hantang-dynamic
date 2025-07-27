import { config } from "../../config";
import type { VideoData } from "../../types";
import { saveAsCSV } from "./csv";
import { saveToDuckDB } from "./duckdb";
import { saveToMysql } from "./mysql";

export async function exportData(data: VideoData[]) {
  const _timestamp = Date.now();
  const results = [];

  // MySQL export
  if (
    config.export.mysql.enabled &&
    config.export.mysql.host &&
    config.export.mysql.port &&
    config.export.mysql.username &&
    config.export.mysql.password &&
    config.export.mysql.table
  ) {
    const mysqlResult = await saveToMysql(data);
    results.push({ type: "mysql", success: mysqlResult });
  }

  // DuckDB export
  if (config.export.duckdb.enabled) {
    const duckdbResult = await saveToDuckDB(data);
    results.push({ type: "duckdb", success: duckdbResult });
  }

  // CSV export
  if (config.export.csv.enabled) {
    const csvResult = saveAsCSV(data);
    results.push({ type: "csv", success: csvResult });
  }

  return results;
}
