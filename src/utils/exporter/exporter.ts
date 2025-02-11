import { saveToMysql } from "./mysql";
import { saveAsCSV } from "./csv";
import { config } from "../../core/config";
import type { VideoData } from "../../core/types";

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
