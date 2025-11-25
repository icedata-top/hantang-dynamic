import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { VideoData } from "../types/models/video.js";
import { logger } from "../utils/logger.js";

/**
 * Discovered user data for tracking new UP主
 */
export interface DiscoveredUserData {
  userId: bigint;
  userName: string;
  fans: number;
  source: "following" | "recommendation";
}

/**
 * User statistics update
 */
export interface UserStatsUpdate {
  videosSeen?: number;
  videosFiltered?: number;
  fans?: number;
  userName?: string;
}

/**
 * Recommendation data
 */
export interface RecommendationData {
  videoBvid: string;
  recommendedByBvid: string;
  recommendCount: number;
  recommendOrder: number;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * User data with statistics
 */
export interface UserData {
  userId: bigint;
  userName: string;
  fans: number;
  videosSeen: number;
  videosFiltered: number;
  filterPassRate: number;
  discoveredFrom: "following" | "recommendation";
  discoveredAt: Date;
  isFollowing: boolean;
  lastUpdated: Date;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  processedVideosCount: number;
  forwardDynamicsCount: number;
  recommendationsCount: number;
  discoveredUsersCount: number;
  filteredVideosCount: number;
}

/**
 * DuckDB database manager - singleton pattern
 * Manages database connection, schema initialization, and CRUD operations
 */
export class Database {
  private static instance: Database | null = null;
  private duckDBInstance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

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
  public async init(path: string): Promise<void> {
    if (this.connection) {
      logger.warn("Database already initialized");
      return;
    }

    logger.info(`Initializing DuckDB at ${path}`);

    try {
      // Create or connect to DuckDB instance
      this.duckDBInstance = await DuckDBInstance.create(path);
      this.connection = await this.duckDBInstance.connect();

      // Initialize schema
      await this.initializeSchema();

      logger.info("DuckDB initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize DuckDB:", error);
      throw error;
    }
  }

  /**
   * Initialize database schema with all required tables
   */
  private async initializeSchema(): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    logger.info("Initializing database schema");

    // Create processed_videos table
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS processed_videos (
        aid BIGINT PRIMARY KEY,
        bvid VARCHAR UNIQUE NOT NULL,
        pubdate BIGINT,
        title VARCHAR,
        description TEXT,
        tag TEXT,
        pic VARCHAR,
        type_id INTEGER,
        user_id BIGINT,
        is_filtered BOOLEAN NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for processed_videos
    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_processed_bvid 
      ON processed_videos(bvid)
    `);

    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_processed_user 
      ON processed_videos(user_id)
    `);

    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_processed_filtered 
      ON processed_videos(is_filtered)
    `);

    // Create forward_dynamics table
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS forward_dynamics (
        forward_dynamic_id BIGINT PRIMARY KEY,
        original_bvid VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for forward_dynamics
    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_forward_bvid 
      ON forward_dynamics(original_bvid)
    `);

    // Create recommendations table
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS recommendations (
        video_bvid VARCHAR,
        recommended_by_bvid VARCHAR,
        recommend_count INTEGER DEFAULT 1,
        recommend_order INTEGER,
        first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (video_bvid, recommended_by_bvid)
      )
    `);

    // Create indexes for recommendations
    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_rec_video 
      ON recommendations(video_bvid)
    `);

    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_rec_count 
      ON recommendations(recommend_count DESC)
    `);

    // Create discovered_users table
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS discovered_users (
        user_id BIGINT PRIMARY KEY,
        user_name VARCHAR,
        fans INTEGER DEFAULT 0,
        videos_seen INTEGER DEFAULT 0,
        videos_filtered INTEGER DEFAULT 0,
        filter_pass_rate REAL DEFAULT 0.0,
        discovered_from VARCHAR,
        discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_following BOOLEAN DEFAULT FALSE,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for discovered_users
    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_user_source 
      ON discovered_users(discovered_from)
    `);

    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_user_rate 
      ON discovered_users(filter_pass_rate DESC)
    `);

    await this.connection.run(`
      CREATE INDEX IF NOT EXISTS idx_user_fans 
      ON discovered_users(fans DESC)
    `);

    logger.info("Database schema initialized");
  }

  /**
   * Check if a video has been processed
   */
  public async hasProcessedVideo(bvid: string): Promise<boolean> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(
      "SELECT COUNT(*) as count FROM processed_videos WHERE bvid = $1",
      { 1: bvid },
    );

    const rows = reader.getRows();
    return (rows[0]?.[0] as number) > 0;
  }

  /**
   * Mark a video as processed
   */
  public async markVideoProcessed(
    video: VideoData,
    filtered: boolean,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    await this.connection.run(
      `
      INSERT INTO processed_videos 
        (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (aid) DO UPDATE SET
        bvid = EXCLUDED.bvid,
        pubdate = EXCLUDED.pubdate,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        tag = EXCLUDED.tag,
        pic = EXCLUDED.pic,
        type_id = EXCLUDED.type_id,
        user_id = EXCLUDED.user_id,
        is_filtered = EXCLUDED.is_filtered,
        updated_at = NOW()
    `,
      {
        1: video.aid,
        2: video.bvid,
        3: video.pubdate,
        4: video.title,
        5: video.description,
        6: video.tag,
        7: video.pic,
        8: video.type_id,
        9: video.user_id,
        10: filtered,
      },
    );
  }

  /**
   * Get processed videos
   */
  public async getProcessedVideos(limit?: number): Promise<VideoData[]> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const sql = limit
      ? `SELECT * FROM processed_videos ORDER BY created_at DESC LIMIT ${limit}`
      : "SELECT * FROM processed_videos ORDER BY created_at DESC";

    const reader = await this.connection.runAndReadAll(sql);
    const rows = reader.getRowObjects();

    return rows.map((row) => ({
      aid: row.aid as bigint,
      bvid: row.bvid as string,
      pubdate: row.pubdate as number,
      title: row.title as string,
      description: row.description as string,
      tag: row.tag as string,
      pic: row.pic as string,
      type_id: row.type_id as number,
      user_id: row.user_id as bigint,
    }));
  }

  /**
   * Get cached forward dynamic BVID
   */
  public async getCachedForwardBvid(dynamicId: string): Promise<string | null> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(
      "SELECT original_bvid FROM forward_dynamics WHERE forward_dynamic_id = $1",
      { 1: BigInt(dynamicId) },
    );

    const rows = reader.getRows();
    return rows.length > 0 ? (rows[0]?.[0] as string) : null;
  }

  /**
   * Cache forward dynamic relationship
   */
  public async cacheForward(dynamicId: string, bvid: string): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    await this.connection.run(
      `
      INSERT INTO forward_dynamics 
        (forward_dynamic_id, original_bvid)
      VALUES ($1, $2)
      ON CONFLICT (forward_dynamic_id) DO UPDATE SET
        original_bvid = EXCLUDED.original_bvid
    `,
      {
        1: BigInt(dynamicId),
        2: bvid,
      },
    );
  }

  /**
   * Track recommendation relationship
   */
  public async trackRecommendation(
    videoBvid: string,
    recommendedByBvid: string,
    order: number,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    // Check if recommendation already exists
    const reader = await this.connection.runAndReadAll(
      `SELECT recommend_count FROM recommendations 
       WHERE video_bvid = $1 AND recommended_by_bvid = $2`,
      { 1: videoBvid, 2: recommendedByBvid },
    );

    const rows = reader.getRows();

    if (rows.length > 0) {
      // Update existing recommendation
      const currentCount = rows[0]?.[0] as number;
      await this.connection.run(
        `UPDATE recommendations 
         SET recommend_count = $1, last_seen = CURRENT_TIMESTAMP, recommend_order = $2
         WHERE video_bvid = $3 AND recommended_by_bvid = $4`,
        {
          1: currentCount + 1,
          2: order,
          3: videoBvid,
          4: recommendedByBvid,
        },
      );
    } else {
      // Insert new recommendation
      await this.connection.run(
        `INSERT INTO recommendations 
         (video_bvid, recommended_by_bvid, recommend_count, recommend_order)
         VALUES ($1, $2, $3, $4)`,
        {
          1: videoBvid,
          2: recommendedByBvid,
          3: 1,
          4: order,
        },
      );
    }
  }

  /**
   * Get top recommended videos
   */
  public async getTopRecommendedVideos(
    limit: number,
  ): Promise<RecommendationData[]> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(
      `SELECT * FROM recommendations 
       ORDER BY recommend_count DESC 
       LIMIT $1`,
      { 1: limit },
    );

    const rows = reader.getRowObjects();

    return rows.map((row) => ({
      videoBvid: row.video_bvid as string,
      recommendedByBvid: row.recommended_by_bvid as string,
      recommendCount: row.recommend_count as number,
      recommendOrder: row.recommend_order as number,
      firstSeen: new Date(row.first_seen as string),
      lastSeen: new Date(row.last_seen as string),
    }));
  }

  /**
   * Check if a user exists in the database
   */
  public async hasUser(userId: bigint): Promise<boolean> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(
      "SELECT COUNT(*) as count FROM discovered_users WHERE user_id = $1",
      { 1: userId },
    );

    const rows = reader.getRows();
    return (rows[0]?.[0] as number) > 0;
  }

  /**
   * Add a discovered user
   */
  public async addDiscoveredUser(user: DiscoveredUserData): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    await this.connection.run(
      `INSERT INTO discovered_users 
       (user_id, user_name, fans, discovered_from, videos_seen, videos_filtered, filter_pass_rate)
       VALUES ($1, $2, $3, $4, 0, 0, 0.0)
       ON CONFLICT (user_id) DO UPDATE SET
         user_name = EXCLUDED.user_name,
         fans = EXCLUDED.fans`,
      {
        1: user.userId,
        2: user.userName,
        3: user.fans,
        4: user.source,
      },
    );
  }

  /**
   * Update user statistics
   */
  public async updateUserStats(
    userId: bigint,
    stats: UserStatsUpdate,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    // Build update query dynamically
    const updates: string[] = [];
    const params: Record<string, bigint | number | string> = { userId };

    if (stats.videosSeen !== undefined) {
      updates.push("videos_seen = videos_seen + $videosSeen");
      params.videosSeen = stats.videosSeen;
    }

    if (stats.videosFiltered !== undefined) {
      updates.push("videos_filtered = videos_filtered + $videosFiltered");
      params.videosFiltered = stats.videosFiltered;
    }

    if (stats.fans !== undefined) {
      updates.push("fans = $fans");
      params.fans = stats.fans;
    }

    if (stats.userName !== undefined) {
      updates.push("user_name = $userName");
      params.userName = stats.userName;
    }

    // Calculate filter pass rate based on updated values
    let filterPassRateCalc = "filter_pass_rate";
    if (stats.videosSeen !== undefined || stats.videosFiltered !== undefined) {
      filterPassRateCalc =
        "CASE WHEN (videos_seen" +
        (stats.videosSeen !== undefined ? " + $videosSeen" : "") +
        ") > 0 THEN CAST((videos_filtered" +
        (stats.videosFiltered !== undefined ? " + $videosFiltered" : "") +
        ") AS REAL) / (videos_seen" +
        (stats.videosSeen !== undefined ? " + $videosSeen" : "") +
        ") ELSE 0.0 END";
    }
    updates.push(`filter_pass_rate = ${filterPassRateCalc}`);
    updates.push("last_updated = NOW()");

    if (updates.length > 0) {
      await this.connection.run(
        `UPDATE discovered_users SET ${updates.join(
          ", ",
        )} WHERE user_id = $userId`,
        params,
      );
    }
  }

  /**
   * Get top discovered users
   */
  public async getTopDiscoveredUsers(
    orderBy: "filter_pass_rate" | "fans",
    limit: number,
  ): Promise<UserData[]> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(
      `SELECT * FROM discovered_users 
       ORDER BY ${orderBy} DESC 
       LIMIT $1`,
      { 1: limit },
    );

    const rows = reader.getRowObjects();

    return rows.map((row) => ({
      userId: row.user_id as bigint,
      userName: row.user_name as string,
      fans: row.fans as number,
      videosSeen: row.videos_seen as number,
      videosFiltered: row.videos_filtered as number,
      filterPassRate: row.filter_pass_rate as number,
      discoveredFrom: row.discovered_from as "following" | "recommendation",
      discoveredAt: new Date(row.discovered_at as string),
      isFollowing: row.is_following as boolean,
      lastUpdated: new Date(row.last_updated as string),
    }));
  }

  /**
   * Get database statistics
   */
  public async getStats(): Promise<DatabaseStats> {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }

    const reader = await this.connection.runAndReadAll(`
      SELECT 
        (SELECT COUNT(*) FROM processed_videos) as processed_count,
        (SELECT COUNT(*) FROM forward_dynamics) as forward_count,
        (SELECT COUNT(*) FROM recommendations) as rec_count,
        (SELECT COUNT(*) FROM discovered_users) as users_count,
        (SELECT COUNT(*) FROM processed_videos WHERE is_filtered = true) as filtered_count
    `);

    const rows = reader.getRows();
    const row = rows[0];

    return {
      processedVideosCount: row[0] as number,
      forwardDynamicsCount: row[1] as number,
      recommendationsCount: row[2] as number,
      discoveredUsersCount: row[3] as number,
      filteredVideosCount: row[4] as number,
    };
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
   * Get the connection (for advanced usage)
   */
  public getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new Error("Database not initialized");
    }
    return this.connection;
  }
}
