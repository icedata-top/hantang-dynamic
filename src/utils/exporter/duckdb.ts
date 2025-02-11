import { DuckDBInstance, DuckDBTimestampValue } from "@duckdb/node-api";
import { VideoData } from "../../core/types";
import { logger } from "../logger";
import { config } from "../../core/config";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export const saveToDuckDB = async (data: VideoData[]) => {
  try {
    const filepath = config.DUCKDB_PATH;
    const dirPath = dirname(filepath);

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    const instance = await DuckDBInstance.create(filepath);
    const connection = await instance.connect();

    await connection.run(`
      CREATE TABLE IF NOT EXISTS videos (
        aid BIGINT PRIMARY KEY,
        bvid VARCHAR,
        pubdate TIMESTAMP,
        title VARCHAR,
        description TEXT,
        tag TEXT,
        pic VARCHAR,
        type_id INTEGER,
        user_id BIGINT
      )
    `);

    // Clear existing data for this batch
    const aids = data.map((d) => d.aid).join(",");
    if (aids.length > 0) {
      await connection.run(`DELETE FROM videos WHERE aid IN (${aids})`);
    }

    const appender = await connection.createAppender("main", "videos");

    for (const record of data) {
      appender.appendBigInt(record.aid);
      appender.appendVarchar(record.bvid);
      appender.appendTimestamp(
        new DuckDBTimestampValue(BigInt(record.pubdate) * 1000n),
      );
      appender.appendVarchar(record.title);
      appender.appendVarchar(record.description);
      appender.appendVarchar(record.tag);
      appender.appendVarchar(record.pic);
      appender.appendInteger(record.type_id);
      appender.appendBigInt(record.user_id);
      appender.endRow();
    }

    await appender.close();
    await connection.close();
    logger.info(`Inserted ${data.length} records into DuckDB file ${filepath}`);
    return true;
  } catch (error) {
    logger.error("DuckDB export failed:", error);
    return false;
  }
};
