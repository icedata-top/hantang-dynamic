import type { Pool } from "pg";

export async function initRecommendationsSchema(pool: Pool): Promise<void> {
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_video
    ON recommendations(video_bvid)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_count
    ON recommendations(recommend_count DESC)
  `);
}
