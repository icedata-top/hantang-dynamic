import type { Pool } from "pg";

export async function initUsersSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_users (
      user_id          BIGINT       PRIMARY KEY,
      user_name        VARCHAR,
      face             VARCHAR,
      fans             INTEGER      DEFAULT 0,
      sign             VARCHAR,
      level            SMALLINT     DEFAULT 0,
      official_role    SMALLINT     DEFAULT -1,
      official_title   VARCHAR,
      videos_seen      INTEGER      DEFAULT 0,
      videos_filtered  INTEGER      DEFAULT 0,
      filter_pass_rate REAL         DEFAULT 0.0,
      filtered_view    BIGINT       DEFAULT 0,
      discovered_at    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
      is_following     BOOLEAN      DEFAULT FALSE,
      followed_by      BIGINT[]     DEFAULT '{}',
      last_updated     TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS videos_seen INTEGER DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS videos_filtered INTEGER DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS filter_pass_rate REAL DEFAULT 0.0
  `);
  await pool.query(`
    ALTER TABLE discovered_users
    ADD COLUMN IF NOT EXISTS filtered_view BIGINT DEFAULT 0
  `);
}
