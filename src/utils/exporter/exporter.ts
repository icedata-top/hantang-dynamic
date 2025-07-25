import { saveToMysql } from "./mysql";
import { saveAsCSV } from "./csv";
import { saveToDuckDB } from "./duckdb";
import { config } from "../../config";
import type { VideoData } from "../../core/types";

export async function exportData(data: VideoData[]) {
  const timestamp = Date.now();
  const results = [];

  if (
    config.outputs.database.mysql.host &&
    config.outputs.database.mysql.port &&
    config.outputs.database.mysql.username &&
    config.outputs.database.mysql.password &&
    config.outputs.database.mysql.table
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
