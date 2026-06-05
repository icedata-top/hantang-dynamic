import { config } from "../../config";
import { exportsTotal } from "../../metrics/registry";
import type { VideoData } from "../../types";
import { saveToMysql } from "./mysql";

export async function exportData(data: VideoData[]) {
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
    exportsTotal.inc({
      target: "mysql",
      result: mysqlResult ? "success" : "error",
    });
    results.push({ type: "mysql", success: mysqlResult });
  }

  return results;
}
