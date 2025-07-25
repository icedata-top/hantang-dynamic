import { DuckDBInstance, DuckDBTimestampValue } from "@duckdb/node-api";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../../config";
import type { VideoData } from "../../core/types";
import { logger } from "../logger";

/**
 * Saves video data to DuckDB export database
 * @param data Array of video data to save
 * @returns Promise<boolean> Success status
 */
export const saveToDuckDB = async (data: VideoData[]): Promise<boolean> => {
  try {
    const filepath = config.export.duckdb.path;
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

    const appender = await connection.createAppender("videos");

    for (const record of data) {
      appender.appendBigInt(BigInt(record.aid));
      appender.appendVarchar(record.bvid);
      appender.appendTimestamp(
        new DuckDBTimestampValue(BigInt(record.pubdate * 1000000)),
      );
      appender.appendVarchar(record.title);
      appender.appendVarchar(record.description);
      appender.appendVarchar(record.tag);
      appender.appendVarchar(record.pic);
      appender.appendInteger(record.type_id);
      appender.appendBigInt(BigInt(record.user_id));
      appender.endRow();
    }

    appender.close();
    connection.close();
    logger.info(`Inserted ${data.length} records into DuckDB file ${filepath}`);
    return true;
  } catch (error) {
    logger.error("DuckDB export failed:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return false;
  }
};
