import type { DuckDBConnection } from "@duckdb/node-api";
import { logger } from "../utils/logger.js";

/**
 * Initialize database schema with all required tables
 */
export async function initializeSchema(
  connection: DuckDBConnection,
): Promise<void> {
  logger.info("Initializing database schema");

  // Create processed_videos table
  await connection.run(`
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

  // Add new columns if they don't exist (schema migration)
  const newColumns = [
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS staff BIGINT[]",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS tid_v2 INTEGER",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS dynamic TEXT",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS tag_new VARCHAR[]",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS participle VARCHAR[]",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS ctime BIGINT",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS copyright INTEGER",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS extras JSON",
    "ALTER TABLE processed_videos ADD COLUMN IF NOT EXISTS notes JSON",
  ];
  for (const sql of newColumns) {
    await connection.run(sql);
  }

  // Migrate JSON array columns to native array types if needed
  await migrateArrayColumns(connection);

  // Create indexes for processed_videos
  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_processed_bvid 
    ON processed_videos(bvid)
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_processed_user 
    ON processed_videos(user_id)
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_processed_filtered 
    ON processed_videos(is_filtered)
  `);

  // Create forward_dynamics table
  await connection.run(`
    CREATE TABLE IF NOT EXISTS forward_dynamics (
      forward_dynamic_id BIGINT PRIMARY KEY,
      original_bvid VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create index for forward_dynamics
  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_forward_bvid 
    ON forward_dynamics(original_bvid)
  `);

  // Create recommendations table
  await connection.run(`
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
  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_rec_video 
    ON recommendations(video_bvid)
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_rec_count 
    ON recommendations(recommend_count DESC)
  `);

  // Create discovered_users table
  await connection.run(`
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
  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_user_source 
    ON discovered_users(discovered_from)
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_user_rate 
    ON discovered_users(filter_pass_rate DESC)
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_user_fans 
    ON discovered_users(fans DESC)
  `);

  logger.info("Database schema initialized");
}

/**
 * Migrate JSON array columns to native array types if they exist as JSON.
 * Uses CREATE TABLE AS SELECT approach for efficient bulk migration.
 */
async function migrateArrayColumns(
  connection: DuckDBConnection,
): Promise<void> {
  // Check if migration is needed by inspecting column types
  const columnsReader = await connection.runAndReadAll(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'processed_videos' 
      AND column_name IN ('staff', 'tag_new', 'participle')
  `);

  const columns = columnsReader.getRowObjects();
  const needsMigration = columns.some(
    (col) => (col.data_type as string).toUpperCase() === "JSON",
  );

  if (!needsMigration) {
    logger.debug(
      "Array columns already using native types, skipping migration",
    );
    return;
  }

  logger.info("Migrating JSON array columns to native array types...");

  // Create new table with correct types using EXCLUDE + type cast
  await connection.run(`
    CREATE TABLE processed_videos_new AS
    SELECT 
      * EXCLUDE (staff, tag_new, participle),
      staff::BIGINT[] AS staff,
      tag_new::VARCHAR[] AS tag_new,
      participle::VARCHAR[] AS participle
    FROM processed_videos
  `);

  // Drop old table and rename new one
  await connection.run("DROP TABLE processed_videos");
  await connection.run(
    "ALTER TABLE processed_videos_new RENAME TO processed_videos",
  );

  // Rebuild indexes
  await connection.run(
    "CREATE INDEX idx_processed_bvid ON processed_videos(bvid)",
  );
  await connection.run(
    "CREATE INDEX idx_processed_user ON processed_videos(user_id)",
  );
  await connection.run(
    "CREATE INDEX idx_processed_filtered ON processed_videos(is_filtered)",
  );

  logger.info("Array column migration completed");
}
