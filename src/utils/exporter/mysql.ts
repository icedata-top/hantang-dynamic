import mysql from "mysql2/promise";
import { config } from "../../config";
import { VideoData } from "../../core/types";
import { logger } from "../logger";

export const saveToMysql = async (data: VideoData[]) => {
  if (
    !config.outputs.database.mysql.host ||
    !config.outputs.database.mysql.port ||
    !config.outputs.database.mysql.username ||
    !config.outputs.database.mysql.password ||
    !config.outputs.database.mysql.table
  ) {
    logger.warn("Missing MySQL configuration. Falling back to CSV export.");
    return false;
  }

  try {
    const connection = await mysql.createConnection({
      host: config.outputs.database.mysql.host,
      port: config.outputs.database.mysql.port,
      user: config.outputs.database.mysql.username,
      password: config.outputs.database.mysql.password,
      database: config.outputs.database.mysql.database,
    });

    // Insert each record into the specified table
    const table = config.outputs.database.mysql.table;
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
