import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../../config";
import type { VideoData } from "../../core/types";
import { logger } from "../logger";

/**
 * AID Filter for deduplication using DuckDB
 * Manages a dedicated DuckDB database for tracking processed AIDs
 */
export class AIDFilter {
  private readonly filepath: string;

  constructor() {
    this.filepath = config.processing.deduplication.aidsDuckdbPath;
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists(): void {
    const dirPath = dirname(this.filepath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Initializes the AID database if it doesn't exist
   */
  private async initializeDatabase(): Promise<void> {
    const instance = await DuckDBInstance.create(this.filepath);
    const connection = await instance.connect();

    await connection.run(`
      CREATE TABLE IF NOT EXISTS aids (
        aid BIGINT PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    connection.close();
  }

  /**
   * Filters new AIDs from a list and records them in the database
   * @param aids Array of AIDs to check
   * @returns Array of new AIDs that haven't been processed before
   */
  async filterNewAIDs(aids: bigint[]): Promise<bigint[]> {
    try {
      if (aids.length === 0) {
        return [];
      }

      await this.initializeDatabase();

      const instance = await DuckDBInstance.create(this.filepath);
      const connection = await instance.connect();

      const values = aids.map((aid) => `(${aid})`).join(",");
      const newAids = (await connection
        .runAndRead(
          `
          WITH input_aids AS (
            SELECT unnest(ARRAY[${values}]) AS aid
          )
          INSERT INTO aids (aid)
          SELECT aid FROM input_aids
          ON CONFLICT DO NOTHING
          RETURNING aid
          `,
        )
        .then((res) => res.getColumns()[0])) as bigint[];

      connection.close();
      logger.info(
        `Found ${newAids.length} new AIDs out of ${aids.length} total`,
      );
      return newAids;
    } catch (error) {
      logger.error("Filtering new AIDs failed:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return [];
    }
  }

  /**
   * Records AIDs as processed without filtering (for manual recording)
   * @param aids Array of AIDs to record
   */
  async recordProcessedAIDs(aids: bigint[]): Promise<boolean> {
    try {
      if (aids.length === 0) {
        return true;
      }

      await this.initializeDatabase();

      const instance = await DuckDBInstance.create(this.filepath);
      const connection = await instance.connect();

      const values = aids.map((aid) => `(${aid})`).join(",");
      await connection.run(`
        INSERT OR IGNORE INTO aids (aid)
        VALUES ${values}
      `);

      connection.close();
      logger.info(`Recorded ${aids.length} AIDs as processed`);
      return true;
    } catch (error) {
      logger.error("Recording processed AIDs failed:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return false;
    }
  }

  /**
   * Filters video data to only include new AIDs and records them
   * @param videoData Array of video data
   * @returns Array of video data with only new AIDs
   */
  async filterNewVideoData(videoData: VideoData[]): Promise<VideoData[]> {
    const aids = videoData.map((d) => BigInt(d.aid));
    const newAids = await this.filterNewAIDs(aids);
    const newVideoData = videoData.filter((d) =>
      newAids.includes(BigInt(d.aid)),
    );

    logger.info(
      `Filtered ${newVideoData.length} new videos out of ${videoData.length} total`,
    );
    return newVideoData;
  }

  /**
   * Checks if specific AIDs have been processed
   * @param aids Array of AIDs to check
   * @returns Array of AIDs that have been processed
   */
  async getProcessedAIDs(aids: bigint[]): Promise<bigint[]> {
    try {
      if (aids.length === 0) {
        return [];
      }

      await this.initializeDatabase();

      const instance = await DuckDBInstance.create(this.filepath);
      const connection = await instance.connect();

      const values = aids.map((aid) => `${aid}`).join(",");
      const processedAids = (await connection
        .runAndRead(`
          SELECT aid FROM aids 
          WHERE aid IN (${values})
        `)
        .then((res) => res.getColumns()[0])) as bigint[];

      connection.close();
      return processedAids;
    } catch (error) {
      logger.error("Checking processed AIDs failed:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return [];
    }
  }

  /**
   * Gets the count of processed AIDs
   * @returns Number of processed AIDs
   */
  async getProcessedCount(): Promise<number> {
    try {
      await this.initializeDatabase();

      const instance = await DuckDBInstance.create(this.filepath);
      const connection = await instance.connect();

      const result = await connection
        .runAndRead("SELECT COUNT(*) as count FROM aids")
        .then((res) => res.getColumns()[0][0]);

      connection.close();
      return Number(result);
    } catch (error) {
      logger.error("Getting processed count failed:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return 0;
    }
  }

  /**
   * Resets the AID database by dropping and recreating the table
   * @returns Success status
   */
  async resetDatabase(): Promise<boolean> {
    try {
      await this.initializeDatabase();

      const instance = await DuckDBInstance.create(this.filepath);
      const connection = await instance.connect();

      await connection.run("DROP TABLE IF EXISTS aids");
      await connection.run(`
        CREATE TABLE aids (
          aid BIGINT PRIMARY KEY,
          processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      connection.close();
      logger.info("AID database has been reset");
      return true;
    } catch (error) {
      logger.error("Resetting database failed:", error);
      if (error instanceof Error) {
        logger.error(error.stack);
      }
      return false;
    }
  }
}

// Create a singleton instance for global use
export const aidFilter = new AIDFilter();
