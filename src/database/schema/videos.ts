import type { Pool } from "pg";

export async function initVideosSchema(pool: Pool): Promise<void> {
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
}
