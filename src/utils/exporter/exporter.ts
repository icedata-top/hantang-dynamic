import { saveToMysql } from "./mysql";
import { saveAsCSV } from "./csv";
import { saveToDuckDB } from "./duckdb";
import { config } from "../../core/config";
import type { VideoData } from "../../core/types";

export async function exportData(data: VideoData[]) {
  const timestamp = Date.now();
  const results = [];

  if (
    config.MYSQL_IP &&
    config.MYSQL_PORT &&
    config.MYSQL_USERNAME &&
    config.MYSQL_PASSWORD &&
    config.MYSQL_TABLE
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
