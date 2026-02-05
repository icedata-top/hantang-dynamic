import { Pool } from "pg";
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
  markVideoDeleted,
  markVideoProcessed,
} from "./videos.js";

/**
 * PostgreSQL database manager - singleton pattern
 * Manages database connection pool, schema initialization, and CRUD operations
 * Thread-safe through mutex locking
 */
export class Database {
  private static instance: Database | null = null;
  private pool: Pool | null = null;
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
   * Initialize the database connection pool and schema
   */
  public async init(url: string = config.database.url): Promise<void> {
    if (this.pool) {
      logger.warn("Database already initialized");
      return;
    }

    logger.info("Initializing PostgreSQL connection pool");

    try {
      // Create connection pool
      this.pool = new Pool({
        connectionString: url,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Test connection
      const client = await this.pool.connect();
      client.release();

      // Initialize schema
      await initializeSchema(this.pool);

      logger.info("PostgreSQL initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize PostgreSQL:", error);
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
   * Ensure pool is available
   */
  private ensurePool(): Pool {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }
    return this.pool;
  }

  // ===== Video Operations =====

  /**
   * Check if a video has been processed
   */
  public async hasProcessedVideo(bvid: string): Promise<boolean> {
    return this.withMutex(() => hasProcessedVideo(this.ensurePool(), bvid));
  }

  /**
   * Check if a video has been processed by ID (AID or BVID)
   */
  public async hasProcessedVideoById(
    id: string | number | bigint,
  ): Promise<boolean> {
    return this.withMutex(() => hasProcessedVideoById(this.ensurePool(), id));
  }

  /**
   * Get all processed video IDs of a specific type (aid or bvid)
   */
  public async getAllProcessedIds(type: "aid" | "bvid"): Promise<Set<string>> {
    return this.withMutex(() => getAllProcessedIds(this.ensurePool(), type));
  }

  /**
   * Mark a video as deleted, preserving existing fields.
   * Optionally records the API error code and message in notes.
   */
  public async markVideoDeleted(
    bvid: string,
    notes?: { api_code?: number; api_message?: string },
  ): Promise<void> {
    return this.withMutex(() =>
      markVideoDeleted(this.ensurePool(), bvid, notes),
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
      markVideoProcessed(this.ensurePool(), video, filtered),
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
      getProcessedVideos(this.ensurePool(), limit, where),
    );
  }

  /**
   * Get list of bvids only (lightweight, for batch processing)
   */
  public async getBvidList(where?: string): Promise<string[]> {
    return this.withMutex(() => getBvidList(this.ensurePool(), where));
  }

  // ===== Forward Dynamics Operations =====

  /**
   * Get cached forward dynamic BVID
   */
  public async getCachedForwardBvid(dynamicId: string): Promise<string | null> {
    return this.withMutex(() =>
      getCachedForwardBvid(this.ensurePool(), dynamicId),
    );
  }

  /**
   * Cache forward dynamic relationship
   */
  public async cacheForward(dynamicId: string, bvid: string): Promise<void> {
    return this.withMutex(() =>
      cacheForward(this.ensurePool(), dynamicId, bvid),
    );
  }

  // ===== User Operations =====

  /**
   * Check if a user exists in the database
   */
  public async hasUser(userId: bigint): Promise<boolean> {
    return this.withMutex(() => hasUser(this.ensurePool(), userId));
  }

  /**
   * Add a discovered user
   */
  public async addDiscoveredUser(user: DiscoveredUserData): Promise<void> {
    return this.withMutex(() => addDiscoveredUser(this.ensurePool(), user));
  }

  /**
   * Update user statistics
   */
  public async updateUserStats(
    userId: bigint,
    stats: UserStatsUpdate,
  ): Promise<void> {
    return this.withMutex(() =>
      updateUserStats(this.ensurePool(), userId, stats),
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
      getTopDiscoveredUsers(this.ensurePool(), orderBy, limit),
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
      trackRecommendationsBatch(this.ensurePool(), recommendations),
    );
  }

  /**
   * Get top recommended videos
   */
  public async getTopRecommendedVideos(
    limit: number,
  ): Promise<RecommendationData[]> {
    return this.withMutex(() =>
      getTopRecommendedVideos(this.ensurePool(), limit),
    );
  }

  // ===== Stats Operations =====

  /**
   * Get database statistics
   */
  public async getStats(): Promise<DatabaseStats> {
    return this.withMutex(() => getStats(this.ensurePool()));
  }

  // ===== Connection Management =====

  /**
   * Close the database connection pool
   */
  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    logger.info("Database connection pool closed");
  }

  /**
   * Get the connection pool (for advanced usage)
   */
  public getPool(): Pool {
    return this.ensurePool();
  }
}
