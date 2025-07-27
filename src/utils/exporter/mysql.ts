import mysql from "mysql2/promise";
import { config } from "../../config";
import type { VideoData } from "../../types";
import { logger } from "../logger";

export const saveToMysql = async (data: VideoData[]) => {
  if (
    !config.export.mysql.host ||
    !config.export.mysql.port ||
    !config.export.mysql.username ||
    !config.export.mysql.password ||
    !config.export.mysql.table
  ) {
    logger.warn("Missing MySQL configuration. Falling back to CSV export.");
    return false;
  }

  try {
    const connection = await mysql.createConnection({
      host: config.export.mysql.host,
      port: config.export.mysql.port,
      user: config.export.mysql.username,
      password: config.export.mysql.password,
      database: config.export.mysql.database,
    });

    // Insert each record into the specified table
    const table = config.export.mysql.table;
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
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return false;
  }
};
