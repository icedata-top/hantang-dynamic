import type { Pool } from "pg";

export async function initDynamicsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dynamics (
      dynamic_id BIGINT PRIMARY KEY,
      user_id BIGINT,
      type SMALLINT NOT NULL,
      timestamp BIGINT,
      bvid VARCHAR,
      orig_dynamic_id BIGINT,
      orig_type SMALLINT,
      text_content TEXT,
      forward_text TEXT,
      images JSONB,
      title TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Safe to re-run: drop NOT NULL on columns that may have been created strict in a prior version
  await pool.query(`ALTER TABLE dynamics ALTER COLUMN user_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE dynamics ALTER COLUMN timestamp DROP NOT NULL`);

  // Add title column for article dynamics (type=64)
  await pool.query(`ALTER TABLE dynamics ADD COLUMN IF NOT EXISTS title TEXT`);

  // Drop card and extend_json columns (no longer stored)
  await pool.query(`ALTER TABLE dynamics DROP COLUMN IF EXISTS card`);
  await pool.query(`ALTER TABLE dynamics DROP COLUMN IF EXISTS extend_json`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dynamics_user_id
    ON dynamics(user_id)
    WHERE user_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dynamics_timestamp
    ON dynamics(timestamp)
    WHERE timestamp IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dynamics_bvid
    ON dynamics(bvid)
    WHERE bvid IS NOT NULL
  `);

  // One-time migration: copy forward_dynamics rows into dynamics, then drop the table.
  // Migrated rows use user_id=NULL and timestamp from created_at since the original
  // table did not store those fields.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'forward_dynamics'
      ) THEN
        INSERT INTO dynamics (dynamic_id, type, timestamp, bvid)
        SELECT
          forward_dynamic_id,
          1,
          EXTRACT(EPOCH FROM created_at)::BIGINT,
          original_bvid
        FROM forward_dynamics
        ON CONFLICT (dynamic_id) DO UPDATE SET
          bvid = COALESCE(EXCLUDED.bvid, dynamics.bvid);

        DROP TABLE forward_dynamics;
      END IF;
    END;
    $$
  `);
}
