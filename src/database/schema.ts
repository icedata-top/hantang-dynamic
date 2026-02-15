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
      face VARCHAR,
      fans INTEGER DEFAULT 0,
      sign VARCHAR,
      level SMALLINT DEFAULT 0,
      official_role SMALLINT DEFAULT -1,
      official_title VARCHAR,
      videos_seen INTEGER DEFAULT 0,
      videos_filtered INTEGER DEFAULT 0,
      filter_pass_rate REAL DEFAULT 0.0,
      discovered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_following BOOLEAN DEFAULT FALSE,
      followed_by BIGINT[] DEFAULT '{}',
      last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for discovered_users
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_rate
    ON discovered_users(filter_pass_rate DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_fans
    ON discovered_users(fans DESC)
  `);

  // Migrations for existing databases
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS followed_by BIGINT[] DEFAULT '{}'
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS face VARCHAR
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    DROP COLUMN IF EXISTS discovered_from
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS sign VARCHAR
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS level SMALLINT DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS official_role SMALLINT DEFAULT -1
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS official_title VARCHAR
  `);

  // Create video_history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_history (
      id BIGSERIAL PRIMARY KEY,
      aid BIGINT NOT NULL,
      bvid VARCHAR NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      title VARCHAR,
      description TEXT,
      tag TEXT,
      tag_new VARCHAR[],
      pic VARCHAR,
      is_deleted BOOLEAN,
      is_filtered BOOLEAN,
      extras JSONB,
      notes JSONB
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vh_bvid_time
    ON video_history(bvid, recorded_at DESC)
  `);

  // Trigger function: insert history snapshot on INSERT or relevant field changes
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_history()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT'
         OR OLD.title       IS DISTINCT FROM NEW.title
         OR OLD.description IS DISTINCT FROM NEW.description
         OR OLD.tag         IS DISTINCT FROM NEW.tag
         OR OLD.tag_new     IS DISTINCT FROM NEW.tag_new
         OR OLD.pic         IS DISTINCT FROM NEW.pic
         OR OLD.is_deleted  IS DISTINCT FROM NEW.is_deleted
         OR OLD.is_filtered IS DISTINCT FROM NEW.is_filtered
         OR OLD.extras      IS DISTINCT FROM NEW.extras
         OR OLD.notes       IS DISTINCT FROM NEW.notes
      THEN
        INSERT INTO video_history
          (aid, bvid, recorded_at, title, description, tag, tag_new, pic,
           is_deleted, is_filtered, extras, notes)
        VALUES
          (NEW.aid, NEW.bvid, NOW(), NEW.title, NEW.description, NEW.tag, NEW.tag_new, NEW.pic,
           NEW.is_deleted, NEW.is_filtered, NEW.extras, NEW.notes);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_video_history ON processed_videos
  `);
  await pool.query(`
    CREATE TRIGGER trg_video_history
    AFTER INSERT OR UPDATE ON processed_videos
    FOR EACH ROW EXECUTE FUNCTION fn_video_history()
  `);

  // Optional: TimescaleDB hypertable
  try {
    await pool.query(`
      SELECT create_hypertable(
        'video_history', 'recorded_at',
        if_not_exists => TRUE,
        migrate_data   => TRUE
      )
    `);
    logger.info("video_history: TimescaleDB hypertable enabled");
  } catch {
    logger.debug("video_history: TimescaleDB not available, using plain table");
  }

  // Create user_profile_history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profile_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_name VARCHAR,
      face VARCHAR,
      fans INTEGER,
      sign VARCHAR,
      level SMALLINT,
      official_role SMALLINT,
      official_title VARCHAR
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_uph_user_time
    ON user_profile_history(user_id, recorded_at DESC)
  `);

  // Trigger function: insert history snapshot on INSERT or relevant field changes
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_user_profile_history()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT'
         OR OLD.user_name    IS DISTINCT FROM NEW.user_name
         OR OLD.face         IS DISTINCT FROM NEW.face
         OR OLD.fans         IS DISTINCT FROM NEW.fans
         OR OLD.sign         IS DISTINCT FROM NEW.sign
         OR OLD.level        IS DISTINCT FROM NEW.level
         OR OLD.official_role  IS DISTINCT FROM NEW.official_role
         OR OLD.official_title IS DISTINCT FROM NEW.official_title
      THEN
        INSERT INTO user_profile_history
          (user_id, recorded_at, user_name, face, fans, sign, level, official_role, official_title)
        VALUES
          (NEW.user_id, NOW(), NEW.user_name, NEW.face, NEW.fans,
           NEW.sign, NEW.level, NEW.official_role, NEW.official_title);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Drop and recreate trigger to ensure it reflects the latest function
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_user_profile_history ON discovered_users
  `);
  await pool.query(`
    CREATE TRIGGER trg_user_profile_history
    AFTER INSERT OR UPDATE ON discovered_users
    FOR EACH ROW EXECUTE FUNCTION fn_user_profile_history()
  `);

  // Optional: convert to TimescaleDB hypertable if extension is available
  try {
    await pool.query(`
      SELECT create_hypertable(
        'user_profile_history', 'recorded_at',
        if_not_exists => TRUE,
        migrate_data   => TRUE
      )
    `);
    logger.info("user_profile_history: TimescaleDB hypertable enabled");
  } catch {
    logger.debug(
      "user_profile_history: TimescaleDB not available, using plain table",
    );
  }

  logger.info("Database schema initialized");
}
