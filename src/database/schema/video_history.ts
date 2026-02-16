import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoHistorySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_history (
      aid         BIGINT       NOT NULL,
      bvid        VARCHAR      NOT NULL,
      recorded_at TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
      title       VARCHAR,
      description TEXT,
      tag         TEXT,
      tag_new     VARCHAR[],
      pic         VARCHAR,
      is_deleted  BOOLEAN,
      is_filtered BOOLEAN,
      extras      JSONB,
      notes       JSONB
    )
  `);

  // 迁移：移除旧的自增 id（阻碍 hypertable PK 约束的根源）
  await pool.query(`
    ALTER TABLE video_history DROP COLUMN IF EXISTS id
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vh_bvid_time
    ON video_history(bvid, recorded_at DESC)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_history()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT'
         OR OLD.title       IS DISTINCT FROM NEW.title
         OR OLD.description IS DISTINCT FROM NEW.description
         OR (SELECT string_agg(t, ',' ORDER BY t) FROM unnest(string_to_array(OLD.tag, ',')) AS t)
              IS DISTINCT FROM
            (SELECT string_agg(t, ',' ORDER BY t) FROM unnest(string_to_array(NEW.tag, ',')) AS t)
         OR (SELECT array_agg(t ORDER BY t) FROM unnest(OLD.tag_new) AS t)
              IS DISTINCT FROM
            (SELECT array_agg(t ORDER BY t) FROM unnest(NEW.tag_new) AS t)
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

  try {
    await pool.query(`
      SELECT create_hypertable(
        'video_history',
        by_range('recorded_at', INTERVAL '90 days'),
        if_not_exists => TRUE,
        migrate_data   => TRUE
      )
    `);
    await pool.query(`
      ALTER TABLE video_history SET (
        timescaledb.compress          = true,
        timescaledb.compress_segmentby = '',
        timescaledb.compress_orderby   = 'aid, recorded_at ASC'
      )
    `);
    await pool.query(`
      SELECT add_compression_policy(
        'video_history',
        compress_after => INTERVAL '7 days',
        if_not_exists  => TRUE
      )
    `);
    logger.info("video_history: TimescaleDB hypertable enabled");
  } catch {
    logger.debug("video_history: TimescaleDB not available, using plain table");
  }
}
