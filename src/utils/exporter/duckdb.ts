import { DuckDBInstance, DuckDBTimestampValue } from "@duckdb/node-api";
import { VideoData } from "../../core/types";
import { logger } from "../logger";
import { config } from "../../config";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export const saveToDuckDB = async (data: VideoData[]) => {
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

// filter videoData with only new AIDs and insert them into DuckDB
/**
 * Filters new AIDs from video data and inserts them into DuckDB, returning the new items
 * @param videoData Array of video data
 * @returns videoData[] Array of video data with only new AIDs
 */
export const filterAndSaveNewAIDsToDuckDB = async (
  videoData: VideoData[],
): Promise<VideoData[]> => {
  let aids = videoData.map((d) => d.aid);
  let newAids = await filterNewAIDs(aids);
  let newVideoData = videoData.filter((d) => newAids.includes(d.aid));
  return newVideoData;
};

/**
 * Filters new AIDs from a list of AIDs and inserts
 * @param aids Array of AIDs
 * @returns Array of new AIDs
 */
export const filterNewAIDs = async (aids: bigint[]): Promise<bigint[]> => {
  try {
    if (aids.length === 0) {
      return [];
    }
    const filepath = config.processing.deduplication.aidsDuckdbPath;
    const dirPath = dirname(filepath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    const instance = await DuckDBInstance.create(filepath);
    const connection = await instance.connect();
    await connection.run(`
      CREATE TABLE IF NOT EXISTS aids (
        aid BIGINT PRIMARY KEY
      )
    `);
    const values = aids.map((aid) => `(${aid})`).join(",");
    const newAids = (await connection
      .runAndRead(
        `
        WITH input_aids AS (
          SELECT unnest(ARRAY[${values}]) AS aid
        )
        INSERT INTO aids 
        SELECT aid FROM input_aids
        ON CONFLICT DO NOTHING
        RETURNING aid
        `,
      )
      .then((res) => res.getColumns()[0])) as bigint[];
    connection.close();
    logger.info(`Found ${newAids.length} new AIDs out of ${aids.length} total`);
    return newAids;
  } catch (error) {
    logger.error("Filtering new AIDs failed:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return [];
  }
};

/**
 * Saves AIDs to a dedicated DuckDB
 * @param aids Array of video aids
 */
export const saveAIDsToDuckDB = async (aids: bigint[]) => {
  try {
    const filepath = config.processing.deduplication.aidsDuckdbPath;
    const dirPath = dirname(filepath);

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    const instance = await DuckDBInstance.create(filepath);
    const connection = await instance.connect();

    await connection.run(`
      CREATE TABLE IF NOT EXISTS aids (
        aid BIGINT PRIMARY KEY
      )
    `);

    // Insert new aids
    if (aids.length > 0) {
      const values = aids.map((aid) => `(${aid})`).join(",");
      await connection.run(`
        INSERT OR IGNORE INTO aids (aid)
        VALUES ${values}
      `);
    }

    connection.close();
    logger.info(`Recorded ${aids.length} AIDs into DuckDB file ${filepath}`);
    return true;
  } catch (error) {
    logger.error("AIDs DuckDB export failed:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return false;
  }
};
