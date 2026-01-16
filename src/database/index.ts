import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { config } from "../config/index.js";
import type {
  DatabaseStats,
  DiscoveredUserData,
  RecommendationData,
  UserData,
  UserStatsUpdate,
} from "../types/models/database.js";
import type { VideoData } from "../types/models/video.js";
import { AsyncMutex } from "../utils/asyncMutex.js";
import { logger } from "../utils/logger.js";

// Import operation modules
import { cacheForward, getCachedForwardBvid } from "./forwards.js";
import {
  getTopRecommendedVideos,
  type RecommendationInput,
  trackRecommendationsBatch,
} from "./recommendations.js";
import { initializeSchema } from "./schema.js";
import { getStats } from "./stats.js";
import {
  addDiscoveredUser,
  getTopDiscoveredUsers,
  hasUser,
  updateUserStats,
} from "./users.js";
import {
  getAllProcessedIds,
  getBvidList,
  getProcessedVideos,
  hasProcessedVideo,
  hasProcessedVideoById,
  markVideoProcessed,
} from "./videos.js";

/**
 * DuckDB database manager - singleton pattern
 * Manages database connection, schema initialization, and CRUD operations
 * Thread-safe through mutex locking
 */
export class Database {
  private static instance: Database | null = null;
  private duckDBInstance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private mutex = new AsyncMutex();

  private constructor() {}

  /**
   * Get the singleton instance
   */
  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  /**
   * Initialize the database connection and schema
   */
  public async init(path: string = config.database.path): Promise<void> {
    if (this.connection) {
      logger.warn("Database already initialized");
      return;
    }

    logger.info(`Initializing DuckDB at ${path}`);

    try {
      // Ensure the database directory exists
      const dbDir = dirname(path);
      mkdirSync(dbDir, { recursive: true });
      logger.debug(`Database directory created/verified: ${dbDir}`);

      // Create or connect to DuckDB instance
      this.duckDBInstance = await DuckDBInstance.create(path);
      this.connection = await this.duckDBInstance.connect();

      // Initialize schema
      await initializeSchema(this.connection);

      logger.info("DuckDB initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize DuckDB:", error);
      throw error;
    }
  }

  /**
   * Execute a database operation with mutex protection
   */
  private async withMutex<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Ensure connection is available
   */
  private ensureConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }
    return this.connection;
  }

  // ===== Video Operations =====

  /**
   * Check if a video has been processed
   */
  public async hasProcessedVideo(bvid: string): Promise<boolean> {
    return this.withMutex(() =>
      hasProcessedVideo(this.ensureConnection(), bvid),
    );
  }

  /**
   * Check if a video has been processed by ID (AID or BVID)
   */
  public async hasProcessedVideoById(
    id: string | number | bigint,
  ): Promise<boolean> {
    return this.withMutex(() =>
      hasProcessedVideoById(this.ensureConnection(), id),
    );
  }

  /**
   * Get all processed video IDs of a specific type (aid or bvid)
   */
  public async getAllProcessedIds(type: "aid" | "bvid"): Promise<Set<string>> {
    return this.withMutex(() =>
      getAllProcessedIds(this.ensureConnection(), type),
    );
  }

  /**
   * Mark a video as processed
   */
  public async markVideoProcessed(
    video: VideoData,
    filtered: boolean,
  ): Promise<void> {
    return this.withMutex(() =>
      markVideoProcessed(this.ensureConnection(), video, filtered),
    );
  }

  /**
   * Get processed videos
   */
  public async getProcessedVideos(
    limit?: number,
    where?: string,
  ): Promise<VideoData[]> {
    return this.withMutex(() =>
      getProcessedVideos(this.ensureConnection(), limit, where),
    );
  }

  /**
   * Get list of bvids only (lightweight, for batch processing)
   */
  public async getBvidList(where?: string): Promise<string[]> {
    return this.withMutex(() => getBvidList(this.ensureConnection(), where));
  }

  // ===== Forward Dynamics Operations =====

  /**
   * Get cached forward dynamic BVID
   */
  public async getCachedForwardBvid(dynamicId: string): Promise<string | null> {
    return this.withMutex(() =>
      getCachedForwardBvid(this.ensureConnection(), dynamicId),
    );
  }

  /**
   * Cache forward dynamic relationship
   */
  public async cacheForward(dynamicId: string, bvid: string): Promise<void> {
    return this.withMutex(() =>
      cacheForward(this.ensureConnection(), dynamicId, bvid),
    );
  }

  // ===== User Operations =====

  /**
   * Check if a user exists in the database
   */
  public async hasUser(userId: bigint): Promise<boolean> {
    return this.withMutex(() => hasUser(this.ensureConnection(), userId));
  }

  /**
   * Add a discovered user
   */
  public async addDiscoveredUser(user: DiscoveredUserData): Promise<void> {
    return this.withMutex(() =>
      addDiscoveredUser(this.ensureConnection(), user),
    );
  }

  /**
   * Update user statistics
   */
  public async updateUserStats(
    userId: bigint,
    stats: UserStatsUpdate,
  ): Promise<void> {
    return this.withMutex(() =>
      updateUserStats(this.ensureConnection(), userId, stats),
    );
  }

  /**
   * Get top discovered users
   */
  public async getTopDiscoveredUsers(
    orderBy: "filter_pass_rate" | "fans",
    limit: number,
  ): Promise<UserData[]> {
    return this.withMutex(() =>
      getTopDiscoveredUsers(this.ensureConnection(), orderBy, limit),
    );
  }

  // ===== Recommendation Operations =====

  /**
   * Batch track recommendation relationships
   */
  public async trackRecommendationsBatch(
    recommendations: RecommendationInput[],
  ): Promise<void> {
    return this.withMutex(() =>
      trackRecommendationsBatch(this.ensureConnection(), recommendations),
    );
  }

  /**
   * Get top recommended videos
   */
  public async getTopRecommendedVideos(
    limit: number,
  ): Promise<RecommendationData[]> {
    return this.withMutex(() =>
      getTopRecommendedVideos(this.ensureConnection(), limit),
    );
  }

  // ===== Stats Operations =====

  /**
   * Get database statistics
   */
  public async getStats(): Promise<DatabaseStats> {
    return this.withMutex(() => getStats(this.ensureConnection()));
  }

  // ===== Connection Management =====

  /**
   * Checkpoint the database to flush WAL to disk
   */
  public async checkpoint(): Promise<void> {
    return this.withMutex(async () => {
      await this.ensureConnection().run("CHECKPOINT");
      logger.debug("Database checkpointed");
    });
  }

  /**
   * Close and reopen the database connection to reduce WAL buildup
   */
  public async reconnect(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      if (!this.duckDBInstance) {
        throw new Error("Database instance not initialized");
      }

      logger.debug("Reconnecting to database...");

      // Close existing connection
      if (this.connection) {
        await this.connection.disconnect();
        this.connection = null;
      }

      // Create new connection
      this.connection = await this.duckDBInstance.connect();
      logger.info("Database reconnected successfully");
    } finally {
      release();
    }
  }

  /**
   * Close the database connection
   */
  public async close(): Promise<void> {
    if (this.connection) {
      await this.connection.disconnect();
      this.connection = null;
    }
    if (this.duckDBInstance) {
      this.duckDBInstance = null;
    }
    logger.info("Database connection closed");
  }

  /**
   * Get the raw connection (for advanced usage)
   */
  public getConnection(): DuckDBConnection {
    return this.ensureConnection();
  }
}
