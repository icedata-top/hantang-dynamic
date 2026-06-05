import { Pool } from "pg";
import { config } from "../config/index.js";
import {
  dbPoolConnections,
  dbQueryDurationSeconds,
  dbQueryErrorsTotal,
} from "../metrics/registry.js";
import type {
  DatabaseStats,
  DiscoveredUserData,
  DynamicData,
  RecommendationData,
  UserData,
  UserProfileSnapshot,
  UserStatsUpdate,
  VideoSnapshot,
} from "../types/models/database.js";
import type {
  DailyCollectionCandidate,
  ProcessedVideoCollectionInput,
  VideoMinuteSample,
} from "../types/models/minute.js";
import type { VideoData } from "../types/models/video.js";
import { logger } from "../utils/logger.js";

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function extractSqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (
    query &&
    typeof query === "object" &&
    "text" in query &&
    typeof query.text === "string"
  ) {
    return query.text;
  }
  return "";
}

function queryOperationLabel(query: unknown): string {
  const sql = extractSqlText(query)
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .toLowerCase();

  const keyword = sql.match(/^[a-z]+/)?.[0] ?? "unknown";
  const tableMatch = sql.match(
    /\b(?:from|into|update|join|table|index on)\s+("?[\w.]+"?)/,
  );
  const table = tableMatch?.[1]?.replace(/"/g, "") ?? "";

  return table ? `${keyword} ${table}` : keyword;
}

// Import operation modules
import {
  advanceFailedMinuteVideos,
  advanceUnchangedMinuteVideos,
  getNextMinuteDueAt,
  refreshVideoCollectionStateFromDaily,
  selectDueMinuteVideos,
  upsertCollectionStateFromProcessedVideo,
} from "./collectionState.js";
import { getCachedForwardBvid, saveDynamic } from "./dynamics.js";
import {
  getTopRecommendedVideos,
  type RecommendationInput,
  trackRecommendationsBatch,
} from "./recommendations.js";
import { initializeSchema } from "./schema/index.js";
import { getStats } from "./stats.js";
import {
  addDiscoveredUser,
  getTopDiscoveredUsers,
  getUserProfileHistory,
  hasUser,
  syncFollowingStatus,
  updateUserStats,
} from "./users.js";
import { getDailyCollectionCandidates } from "./videoDaily.js";
import { insertVideoMinuteSamples } from "./videoMinute.js";
import {
  getAllProcessedIds,
  getBvidList,
  getProcessedVideos,
  getVideoHistory,
  hasProcessedVideo,
  hasProcessedVideoById,
  markVideoDeleted,
  markVideoProcessed,
} from "./videos.js";

/**
 * PostgreSQL database manager - singleton pattern
 * Manages database connection pool, schema initialization, and CRUD operations
 */
export class Database {
  private static instance: Database | null = null;
  private pool: Pool | null = null;
  private poolMetricsTimer: NodeJS.Timeout | null = null;

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
   * Initialize the database connection pool.
   *
   * Schema initialization is intentionally opt-in. Normal startup and restarts
   * should not run DDL against the database; run `--init-schema` for install or
   * upgrade steps that explicitly need it.
   */
  public async init(
    url: string = config.database.url,
    options: { initializeSchema?: boolean } = {},
  ): Promise<void> {
    if (this.pool) {
      logger.warn("Database already initialized");
      return;
    }

    logger.info("Initializing PostgreSQL connection pool");

    try {
      const schema = config.database.schema;

      // Create connection pool
      this.pool = new Pool({
        connectionString: url,
        max: config.application.concurrencyLimit || 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        // Startup options run before pg exposes the client to pool queries.
        // A pool "connect" hook cannot be awaited and can race the first query.
        options: `-c search_path=${quotePostgresIdentifier(schema)}`,
      });
      this.wrapPoolQuery(this.pool);
      this.startPoolMetricsSampler(this.pool);

      // Test connection
      const client = await this.pool.connect();
      client.release();

      if (options.initializeSchema === true) {
        await initializeSchema(this.pool, schema);
      }

      logger.info("PostgreSQL initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize PostgreSQL:", error);
      throw error;
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

  private wrapPoolQuery(pool: Pool): void {
    const originalQuery = pool.query.bind(pool) as (
      ...args: unknown[]
    ) => unknown;

    pool.query = ((...args: unknown[]): unknown => {
      const callbackCandidate = args[args.length - 1];
      if (typeof callbackCandidate === "function") {
        return originalQuery(...args);
      }

      const operation = queryOperationLabel(args[0]);
      const endQuery = dbQueryDurationSeconds.startTimer({ operation });

      try {
        const result = originalQuery(...args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>)
            .catch((error) => {
              dbQueryErrorsTotal.inc({ operation });
              throw error;
            })
            .finally(() => {
              endQuery();
            });
        }

        endQuery();
        return result;
      } catch (error) {
        dbQueryErrorsTotal.inc({ operation });
        endQuery();
        throw error;
      }
    }) as Pool["query"];
  }

  private startPoolMetricsSampler(pool: Pool): void {
    const sample = () => {
      dbPoolConnections.set({ state: "total" }, pool.totalCount);
      dbPoolConnections.set({ state: "idle" }, pool.idleCount);
      dbPoolConnections.set({ state: "waiting" }, pool.waitingCount);
    };

    sample();
    this.poolMetricsTimer = setInterval(sample, 15_000);
    this.poolMetricsTimer.unref();
  }

  // ===== Video Operations =====

  /**
   * Check if a video has been processed
   */
  public async hasProcessedVideo(bvid: string): Promise<boolean> {
    return hasProcessedVideo(this.ensurePool(), bvid);
  }

  /**
   * Check if a video has been processed by ID (AID or BVID)
   */
  public async hasProcessedVideoById(
    id: string | number | bigint,
  ): Promise<boolean> {
    return hasProcessedVideoById(this.ensurePool(), id);
  }

  /**
   * Get all processed video IDs of a specific type (aid or bvid)
   */
  public async getAllProcessedIds(type: "aid" | "bvid"): Promise<Set<string>> {
    return getAllProcessedIds(this.ensurePool(), type);
  }

  /**
   * Mark a video as deleted, preserving existing fields.
   * Optionally records the API error code and message in notes.
   */
  public async markVideoDeleted(
    bvid: string,
    notes?: { api_code?: number; api_message?: string },
  ): Promise<void> {
    return markVideoDeleted(this.ensurePool(), bvid, notes);
  }

  /**
   * Mark a video as processed
   */
  public async markVideoProcessed(
    video: VideoData,
    filtered: boolean,
  ): Promise<void> {
    return markVideoProcessed(this.ensurePool(), video, filtered);
  }

  /**
   * Get processed videos
   */
  public async getProcessedVideos(
    limit?: number,
    where?: string,
  ): Promise<VideoData[]> {
    return getProcessedVideos(this.ensurePool(), limit, where);
  }

  /**
   * Get list of bvids only (lightweight, for batch processing)
   */
  public async getBvidList(where?: string): Promise<string[]> {
    return getBvidList(this.ensurePool(), where);
  }

  /**
   * Get change history for a video
   */
  public async getVideoHistory(
    bvid: string,
    limit?: number,
  ): Promise<VideoSnapshot[]> {
    return getVideoHistory(this.ensurePool(), bvid, limit);
  }

  // ===== Dynamic Operations =====

  /**
   * Save a dynamic post and its content to the database.
   * For type=1 forwards, the resolved bvid also acts as a forward→bvid cache entry.
   */
  public async saveDynamic(data: DynamicData): Promise<void> {
    return saveDynamic(this.ensurePool(), data);
  }

  // ===== Forward Dynamics Operations =====

  /**
   * Get the resolved original video BVID for a forward dynamic.
   */
  public async getCachedForwardBvid(dynamicId: string): Promise<string | null> {
    return getCachedForwardBvid(this.ensurePool(), dynamicId);
  }

  // ===== User Operations =====

  /**
   * Check if a user exists in the database
   */
  public async hasUser(userId: bigint): Promise<boolean> {
    return hasUser(this.ensurePool(), userId);
  }

  /**
   * Add a discovered user
   */
  public async addDiscoveredUser(user: DiscoveredUserData): Promise<void> {
    return addDiscoveredUser(this.ensurePool(), user);
  }

  /**
   * Update user statistics
   */
  public async updateUserStats(
    userId: bigint,
    stats: UserStatsUpdate,
  ): Promise<void> {
    return updateUserStats(this.ensurePool(), userId, stats);
  }

  /**
   * Get top discovered users
   */
  public async getTopDiscoveredUsers(
    orderBy: "filter_pass_rate" | "fans",
    limit: number,
  ): Promise<UserData[]> {
    return getTopDiscoveredUsers(this.ensurePool(), orderBy, limit);
  }

  /**
   * Get profile change history for a user
   */
  public async getUserProfileHistory(
    userId: bigint,
    limit?: number,
  ): Promise<UserProfileSnapshot[]> {
    return getUserProfileHistory(this.ensurePool(), userId, limit);
  }

  /**
   * Sync followed_by and is_following for a specific crawler UID.
   */
  public async syncFollowingStatus(
    crawlerUid: string,
    followingIds: Set<string>,
  ): Promise<void> {
    return syncFollowingStatus(this.ensurePool(), crawlerUid, followingIds);
  }

  // ===== Recommendation Operations =====

  /**
   * Batch track recommendation relationships
   */
  public async trackRecommendationsBatch(
    recommendations: RecommendationInput[],
  ): Promise<void> {
    return trackRecommendationsBatch(this.ensurePool(), recommendations);
  }

  /**
   * Get top recommended videos
   */
  public async getTopRecommendedVideos(
    limit: number,
  ): Promise<RecommendationData[]> {
    return getTopRecommendedVideos(this.ensurePool(), limit);
  }

  // ===== Stats Operations =====

  /**
   * Get database statistics
   */
  public async getStats(): Promise<DatabaseStats> {
    return getStats(this.ensurePool());
  }

  // ===== Adaptive Minute Operations =====

  public async getDailyCollectionCandidates(options?: {
    includeWeeklyOnly?: boolean;
    now?: Date;
    businessTimezone?: string;
    limit?: number;
  }): Promise<DailyCollectionCandidate[]> {
    return getDailyCollectionCandidates(this.ensurePool(), options);
  }

  public async refreshVideoCollectionStateFromDaily(
    aids?: bigint[],
    now?: Date,
  ): Promise<number> {
    return refreshVideoCollectionStateFromDaily(this.ensurePool(), aids, now, {
      targetDeltaPerSample: config.minute.targetDeltaPerSample,
      targetDeltaLower: config.minute.targetDeltaLower,
      targetDeltaUpper: config.minute.targetDeltaUpper,
      minPositivePriority: config.minute.minPositivePriority,
      maxPositivePriority: config.minute.maxPositivePriority,
      businessTimezone: config.minute.collectionBusinessTimezone,
    });
  }

  public async upsertCollectionStateFromProcessedVideo(
    input: ProcessedVideoCollectionInput,
    now?: Date,
  ): Promise<string> {
    return upsertCollectionStateFromProcessedVideo(
      this.ensurePool(),
      input,
      now,
      {
        bootstrapPriority: config.minute.bootstrapPriority,
        bootstrapTtlHours: config.minute.bootstrapTtlHours,
        bootstrapLabelContentTypes: config.minute.bootstrapLabelContentTypes,
        bootstrapLabelOrigin: config.minute.bootstrapLabelOrigin,
        bootstrapLabelWriters: config.minute.bootstrapLabelWriters,
        bootstrapTidV2Allowlist: config.minute.bootstrapTidV2Allowlist,
        processedBackfillNewVideoAgeDays:
          config.minute.processedBackfillNewVideoAgeDays,
      },
    );
  }

  // ===== Queue-free minute collection =====

  public async getNextMinuteDueAt(): Promise<Date | null> {
    return getNextMinuteDueAt(this.ensurePool());
  }

  public async selectDueMinuteVideos(
    limit?: number,
    now?: Date,
  ): Promise<
    { aid: bigint; lastView: bigint | null; nearGate: boolean; dueAt: Date }[]
  > {
    return selectDueMinuteVideos(this.ensurePool(), limit, now);
  }

  public async advanceUnchangedMinuteVideos(
    aids: bigint[],
    now?: Date,
  ): Promise<number> {
    return advanceUnchangedMinuteVideos(this.ensurePool(), aids, now);
  }

  public async advanceFailedMinuteVideos(
    aids: bigint[],
    now?: Date,
  ): Promise<number> {
    return advanceFailedMinuteVideos(this.ensurePool(), aids, now);
  }

  public async insertVideoMinuteSamples(
    samples: VideoMinuteSample[],
  ): Promise<number> {
    return insertVideoMinuteSamples(this.ensurePool(), samples);
  }

  // ===== Connection Management =====

  /**
   * Close the database connection pool
   */
  public async close(): Promise<void> {
    if (this.poolMetricsTimer) {
      clearInterval(this.poolMetricsTimer);
      this.poolMetricsTimer = null;
    }
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
