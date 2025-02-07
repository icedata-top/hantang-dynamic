import { saveToMysql } from "../utils/mysql";
import { saveAsCSV } from "../utils/csv";
import { config } from "../core/config";
import type { VideoData } from "../core/types";

export async function exportData(data: VideoData[]) {
  if (
    config.MYSQL_IP &&
    config.MYSQL_PORT &&
    config.MYSQL_USERNAME &&
    config.MYSQL_PASSWORD &&
    config.MYSQL_TABLE
  ) {
    await saveToMysql(data);
  } else {
    saveAsCSV(data, `export_${Date.now()}.csv`);
  }
}
