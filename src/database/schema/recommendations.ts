import type { Pool } from "pg";

export async function initRecommendationsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      video_aid BIGINT,
      recommended_by_aid BIGINT,
      recommend_count INTEGER DEFAULT 1,
      recommend_order INTEGER,
      first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_aid, recommended_by_aid)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_video
    ON recommendations(video_aid)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rec_count
    ON recommendations(recommend_count DESC)
  `);

  // Migration: rename bvid columns to aid (BIGINT) for existing databases
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recommendations' AND column_name = 'video_bvid'
      ) THEN
        ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS video_aid BIGINT;
        ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS recommended_by_aid BIGINT;

        UPDATE recommendations r
        SET video_aid          = pv1.aid,
            recommended_by_aid = pv2.aid
        FROM processed_videos pv1,
             processed_videos pv2
        WHERE r.video_bvid          = pv1.bvid
          AND r.recommended_by_bvid = pv2.bvid;

        DELETE FROM recommendations
        WHERE video_aid IS NULL OR recommended_by_aid IS NULL;

        ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_pkey;
        DROP INDEX IF EXISTS idx_rec_video;

        ALTER TABLE recommendations DROP COLUMN video_bvid;
        ALTER TABLE recommendations DROP COLUMN recommended_by_bvid;

        ALTER TABLE recommendations ADD PRIMARY KEY (video_aid, recommended_by_aid);
      END IF;
    END $$
  `);
}
