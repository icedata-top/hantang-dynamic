import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

/**
 * Gate-crossing tables and helper functions.
 *
 * The video_collection_queue table that used to live here has been removed —
 * queue-free scheduling via video_collection_state + fn_select_due_minute_videos
 * replaced it entirely.
 */
export async function initCollectionQueueSchema(pool: Pool): Promise<void> {
  // ── Drop legacy queue table and its indexes ──────────────────────
  await pool.query(`DROP TABLE IF EXISTS video_collection_queue CASCADE`);

  // ── Drop legacy queue-only functions ─────────────────────────────
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_advance_abandoned_minute_collection_state(timestamptz)`,
  );
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_enqueue_video_collection_tasks(timestamptz, integer)`,
  );
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_enqueue_video_collection_gate_tasks(timestamptz, interval, numeric, bigint, integer, text)`,
  );
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_claim_video_collection_tasks(timestamptz, integer, interval)`,
  );
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_ack_video_collection_tasks(bigint[], timestamptz)`,
  );
  await pool.query(
    `DROP FUNCTION IF EXISTS fn_fail_video_collection_tasks(bigint[], timestamptz)`,
  );

  // ── Gate crossing records (still used by triggers) ───────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_collection_gate_crossings (
      id bigserial PRIMARY KEY,
      aid bigint NOT NULL,
      gate_value bigint NOT NULL,
      previous_view bigint,
      current_view bigint,
      crossed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_video_collection_gate_crossing UNIQUE (aid, gate_value)
    )
  `);

  // Drop legacy FK to the now-removed queue table
  await pool.query(`
    ALTER TABLE video_collection_gate_crossings
    DROP CONSTRAINT IF EXISTS video_collection_gate_crossings_source_task_id_fkey
  `);
  await pool.query(`
    ALTER TABLE video_collection_gate_crossings
    DROP COLUMN IF EXISTS source_task_id
  `);

  // ── Gate value helper functions ──────────────────────────────────
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_exact_gate_value(
      p_view bigint
    ) RETURNS bigint AS $$
      SELECT CASE
        WHEN p_view IS NULL OR p_view <= 0 THEN NULL
        WHEN p_view < 10000  AND p_view % 1000   = 0 THEN p_view
        WHEN p_view < 100000 AND p_view % 10000  = 0 THEN p_view
        WHEN p_view >= 100000 AND p_view % 100000 = 0 THEN p_view
        ELSE NULL
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_next_gate_value(
      p_view bigint
    ) RETURNS bigint AS $$
      SELECT CASE
        WHEN p_view IS NULL OR p_view < 0 THEN NULL
        WHEN p_view < 10000  THEN ((p_view / 1000)   + 1) * 1000
        WHEN p_view < 100000 THEN ((p_view / 10000)  + 1) * 10000
        ELSE                      ((p_view / 100000) + 1) * 100000
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_crossed_gate_value(
      p_previous_view bigint,
      p_current_view bigint
    ) RETURNS bigint AS $$
      SELECT CASE
        WHEN p_previous_view IS NULL
          OR p_current_view IS NULL
          OR p_current_view <= p_previous_view
          OR p_current_view < 1000
          THEN NULL
        ELSE (
          SELECT max(v) FROM (VALUES
            (CASE WHEN p_current_view >= 100000
              THEN (p_current_view / 100000) * 100000
            END),
            (CASE WHEN least(p_current_view, 99999) >= 10000
              THEN (least(p_current_view, 99999) / 10000) * 10000
            END),
            (CASE WHEN least(p_current_view, 9999) >= 1000
              THEN (least(p_current_view, 9999) / 1000) * 1000
            END)
          ) AS candidates(v)
          WHERE v > p_previous_view
            AND v > 0
        )
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  logger.info("video_collection_gate_crossings: schema ready");
}
