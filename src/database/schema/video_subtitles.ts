import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initVideoSubtitlesSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_subtitles (
      aid           bigint       NOT NULL,
      cid           bigint       NOT NULL,
      lan           varchar(20)  NOT NULL,
      lan_doc       varchar(50),
      subtitle_type smallint,
      ai_type       smallint,
      ai_status     smallint,
      body          jsonb        NOT NULL,
      plain_text    text,
      line_count    integer,
      style         jsonb,
      fetched_at    timestamptz  NOT NULL DEFAULT now(),
      updated_at    timestamptz  NOT NULL DEFAULT now(),
      PRIMARY KEY (aid, cid, lan)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_subtitles_aid
    ON video_subtitles(aid)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_subtitle_on_gate_crossing()
    RETURNS trigger AS $$
    BEGIN
      UPDATE video_collection_state
      SET subtitle_state = fn_next_subtitle_state(
            subtitle_state,
            greatest(COALESCE(last_view, 0), COALESCE(NEW.current_view, 0)),
            NEW.gate_value
          ),
          updated_at = now()
      WHERE aid = NEW.aid
        AND subtitle_state IS DISTINCT FROM fn_next_subtitle_state(
          subtitle_state,
          greatest(COALESCE(last_view, 0), COALESCE(NEW.current_view, 0)),
          NEW.gate_value
        );

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_subtitle_on_gate_crossing
    ON video_collection_gate_crossings
  `);

  await pool.query(`
    CREATE TRIGGER trg_subtitle_on_gate_crossing
      AFTER INSERT ON video_collection_gate_crossings
      FOR EACH ROW
      EXECUTE FUNCTION fn_subtitle_on_gate_crossing()
  `);

  logger.info("video_subtitles: schema ready");
}
