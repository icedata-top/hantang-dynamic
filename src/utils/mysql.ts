import mysql from "mysql2/promise";
import { config } from "../core/config";
import { VideoData } from "../core/types";

export const saveToMysql = async (data: VideoData[]) => {
  // Check if all MySQL config values are provided
  if (
    !config.MYSQL_IP ||
    !config.MYSQL_PORT ||
    !config.MYSQL_USERNAME ||
    !config.MYSQL_PASSWORD ||
    !config.MYSQL_TABLE
  ) {
    console.error("Missing MySQL configuration. Falling back to CSV export.");
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
    const insertQuery = `
      INSERT IGNORE INTO \`${table}\`
      (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    for (const record of data) {
      const values = [
        record.aid,
        record.bvid,
        record.pubdate,
        record.title,
        record.description,
        record.tag,
        record.pic,
        record.type_id,
        record.user_id,
      ];
      await connection.execute(insertQuery, values);
    }

    console.log(`Inserted ${data.length} records into MySQL table ${table}`);
    await connection.end();
    return true;
  } catch (error) {
    console.error("MySQL export failed:", error);
    return false;
  }
};
