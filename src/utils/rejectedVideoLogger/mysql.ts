import mysql from "mysql2/promise";
import { config } from "../../config";
import type { VideoData } from "../../types";
import { logger } from "../logger";
import type {
  IRejectedVideoLogger,
  RejectionReason,
} from "../rejectedVideoLogger";

export class MySQLRejectedVideoLogger implements IRejectedVideoLogger {
  private connection: mysql.Connection | null = null;

  /**
   * Get or create MySQL connection
   */
  private async getConnection(): Promise<mysql.Connection> {
    if (!this.connection) {
      this.connection = await mysql.createConnection({
        host: config.export.mysql.host,
        port: config.export.mysql.port,
        user: config.export.mysql.username,
        password: config.export.mysql.password,
        database: config.export.mysql.database,
      });
    }
    return this.connection;
  }

  /**
   * Initialize the rejected videos table if it doesn't exist
   */
  async initializeTable(): Promise<void> {
    const connection = await this.getConnection();
    const tableName = config.export.mysql.rejectedTable || "rejected_videos";

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`bvid\` VARCHAR(20) NOT NULL UNIQUE,
        \`aid\` BIGINT NOT NULL,
        \`title\` TEXT,
        \`rejected_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`reason\` VARCHAR(50) NOT NULL,
        INDEX \`idx_bvid\` (\`bvid\`),
        INDEX \`idx_rejected_at\` (\`rejected_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
      await connection.execute(createTableSQL);
      logger.debug(`Initialized rejected videos table: ${tableName}`);
    } catch (error) {
      logger.error(`Failed to initialize rejected videos table: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a video has been rejected before
   */
  async isRejected(bvid: string): Promise<boolean> {
    const connection = await this.getConnection();
    const tableName = config.export.mysql.rejectedTable || "rejected_videos";

    const [rows] = await connection.execute(
      `SELECT 1 FROM \`${tableName}\` WHERE \`bvid\` = ? LIMIT 1`,
      [bvid],
    );

    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Log a rejected video to the database
   */
  async logRejectedVideo(
    video: VideoData,
    reason: RejectionReason,
  ): Promise<void> {
    // Ensure table exists
    await this.initializeTable();

    const connection = await this.getConnection();
    const tableName = config.export.mysql.rejectedTable || "rejected_videos";

    try {
      await connection.execute(
        `INSERT IGNORE INTO \`${tableName}\` (\`bvid\`, \`aid\`, \`title\`, \`reason\`) VALUES (?, ?, ?, ?)`,
        [video.bvid, video.aid.toString(), video.title, reason],
      );
    } catch (error) {
      logger.warn(
        `Failed to log rejected video ${video.bvid} to MySQL:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Clean up old rejected video records
   */
  async cleanupOldRecords(olderThanDays: number): Promise<number> {
    const connection = await this.getConnection();
    const tableName = config.export.mysql.rejectedTable || "rejected_videos";

    const [result] = await connection.execute(
      `DELETE FROM \`${tableName}\` WHERE \`rejected_at\` < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [olderThanDays],
    );

    const affectedRows = (result as mysql.ResultSetHeader).affectedRows;
    logger.info(
      `Cleaned up ${affectedRows} old rejected video records (older than ${olderThanDays} days)`,
    );

    return affectedRows;
  }
}
