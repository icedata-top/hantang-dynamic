import type { Pool } from "pg";
import { logger } from "../utils/logger.js";

/**
 * Initialize database schema with all required tables
 */
export async function initializeSchema(pool: Pool): Promise<void> {
  logger.info("Initializing database schema");

  // Create processed_videos table
  await pool.query(`
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
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      staff BIGINT[],
      tid_v2 INTEGER,
      dynamic TEXT,
      tag_new VARCHAR[],
      participle VARCHAR[],
      ctime BIGINT,
      is_deleted BOOLEAN DEFAULT FALSE,
      copyright INTEGER,
      extras JSONB,
      notes JSONB
    )
  `);

  // Create indexes for processed_videos
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_bvid 
    ON processed_videos(bvid)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_user 
    ON processed_videos(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_filtered 
    ON processed_videos(is_filtered)
  `);

  // Create forward_dynamics table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forward_dynamics (
      forward_dynamic_id BIGINT PRIMARY KEY,
      original_bvid VARCHAR NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create index for forward_dynamics
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_forward_bvid 
    ON forward_dynamics(original_bvid)
  `);

  // Create recommendations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      video_bvid VARCHAR,
      recommended_by_bvid VARCHAR,
      recommend_count INTEGER DEFAULT 1,
      recommend_order INTEGER,
      first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_bvid, recommended_by_bvid)
    )
  `);

  // Create indexes for recommendations
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_video 
    ON recommendations(video_bvid)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_count 
    ON recommendations(recommend_count DESC)
  `);

  // Create discovered_users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_users (
      user_id BIGINT PRIMARY KEY,
      user_name VARCHAR,
      fans INTEGER DEFAULT 0,
      videos_seen INTEGER DEFAULT 0,
      videos_filtered INTEGER DEFAULT 0,
      filter_pass_rate REAL DEFAULT 0.0,
      discovered_from VARCHAR,
      discovered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_following BOOLEAN DEFAULT FALSE,
      last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for discovered_users
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_source 
    ON discovered_users(discovered_from)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_rate 
    ON discovered_users(filter_pass_rate DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_fans 
    ON discovered_users(fans DESC)
  `);

  logger.info("Database schema initialized");
}
