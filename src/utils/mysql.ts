import mysql from "mysql2/promise";
import { config } from "../core/config";
import { VideoData } from "../core/types";
import { logger } from "./logger";

export const saveToMysql = async (data: VideoData[]) => {
  if (
    !config.MYSQL_IP ||
    !config.MYSQL_PORT ||
    !config.MYSQL_USERNAME ||
    !config.MYSQL_PASSWORD ||
    !config.MYSQL_TABLE
  ) {
    logger.warn("Missing MySQL configuration. Falling back to CSV export.");
    return false;
  }

  try {
    const connection = await mysql.createConnection({
      host: config.MYSQL_IP,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USERNAME,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
    });

    // Insert each record into the specified table
    const table = config.MYSQL_TABLE;
    const batchSize = 20;
    const insertQuery = `
      INSERT IGNORE INTO \`${table}\`
      (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id)
      VALUES ?
    `;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const values = batch.map((record) => [
        record.aid,
        record.bvid,
        record.pubdate,
        record.title,
        record.description,
        record.tag,
        record.pic,
        record.type_id,
        record.user_id,
      ]);

      await connection.query(insertQuery, [values]);
      logger.debug(
        `Processed batch ${Math.floor(i / batchSize) + 1}: ${values.length} records at time ${new Date().toLocaleString()}`,
      );
    }

    logger.info(`Inserted ${data.length} records into MySQL table ${table}`);
    await connection.end();
    return true;
  } catch (error) {
    logger.error("MySQL export failed:", error);
    return false;
  }
};
