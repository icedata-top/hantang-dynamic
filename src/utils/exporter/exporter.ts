import { config } from "../../config";
import type { VideoData } from "../../core/types";
import { saveAsCSV } from "./csv";
import { saveToDuckDB } from "./duckdb";
import { saveToMysql } from "./mysql";

export async function exportData(data: VideoData[]) {
  const timestamp = Date.now();
  const results = [];

  if (
    config.export.mysql.host &&
    config.export.mysql.port &&
    config.export.mysql.username &&
    config.export.mysql.password &&
    config.export.mysql.table
  ) {
    const mysqlResult = await saveToMysql(data);
    results.push({ type: "mysql", success: mysqlResult });
  }

  const duckdbResult = await saveToDuckDB(data);
  results.push({ type: "duckdb", success: duckdbResult });

  saveAsCSV(data);
  results.push({ type: "csv", success: true });

  return results;
}
