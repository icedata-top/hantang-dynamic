import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initCollectionQueueSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_collection_queue (
      id bigserial PRIMARY KEY,
      aid bigint NOT NULL,
      task_type text NOT NULL,
      dedupe_key text NOT NULL,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      locked_until timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      gate_value bigint,
      gate_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_video_collection_queue_task_type
        CHECK (task_type IN ('minute', 'gate')),
      CONSTRAINT chk_video_collection_queue_status
        CHECK (status IN ('pending', 'leased', 'completed', 'abandoned'))
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_video_collection_queue_active_dedupe
    ON video_collection_queue(dedupe_key)
    WHERE status IN ('pending', 'leased')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_queue_claim
    ON video_collection_queue(status, task_type, due_at, locked_until, id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_queue_claim_order
    ON video_collection_queue(
      status,
      (CASE WHEN task_type = 'minute' THEN 0 ELSE 1 END),
      due_at,
      id
    )
    WHERE status IN ('pending', 'leased')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_queue_abandoned_dedupe
    ON video_collection_queue(dedupe_key)
    WHERE status = 'abandoned'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_queue_cleanup
    ON video_collection_queue(updated_at)
    WHERE status IN ('completed', 'abandoned')
  `);

  // idx_video_collection_queue_active_aid_type has 0 scans — drop it
  await pool.query(`
    DROP INDEX IF EXISTS idx_video_collection_queue_active_aid_type
  `);

  // Helper: gate step size for a given view count
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_gate_step(
      p_view bigint
    ) RETURNS bigint AS $$
      SELECT CASE
        WHEN p_view IS NULL OR p_view < 1000 THEN 1000
        WHEN p_view < 10000  THEN 1000
        WHEN p_view < 100000 THEN 10000
        ELSE 100000
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

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

  // Drop legacy FK to queue table (new crossings come from triggers, not tasks)
  await pool.query(`
    ALTER TABLE video_collection_gate_crossings
    DROP CONSTRAINT IF EXISTS video_collection_gate_crossings_source_task_id_fkey
  `);
  await pool.query(`
    ALTER TABLE video_collection_gate_crossings
    DROP COLUMN IF EXISTS source_task_id
  `);

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

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_advance_abandoned_minute_collection_state(
      p_now timestamptz DEFAULT now()
    ) RETURNS integer AS $$
    DECLARE
      advanced_count integer;
    BEGIN
      UPDATE video_collection_state s
      SET next_minute_due_at = fn_video_collection_next_due_at(
            s.aid,
            s.priority,
            greatest(
              p_now + interval '1 second',
              q.due_at + make_interval(mins => s.priority)
            )
          ),
          updated_at = p_now
      FROM video_collection_queue q
      WHERE q.aid = s.aid
        AND q.task_type = 'minute'
        AND q.status = 'abandoned'
        AND q.due_at <= p_now
        AND s.priority > 0
        AND s.next_minute_due_at IS NOT NULL
        AND s.next_minute_due_at <= q.due_at;

      GET DIAGNOSTICS advanced_count = ROW_COUNT;
      RETURN advanced_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_enqueue_video_collection_tasks(
      p_now timestamptz DEFAULT now(),
      p_max_attempts integer DEFAULT 5
    ) RETURNS integer AS $$
    DECLARE
      inserted_count integer;
    BEGIN
      DELETE FROM video_collection_queue
      WHERE status IN ('completed', 'abandoned')
        AND updated_at < p_now - interval '3 days';

      WITH expired_bootstrap AS (
        UPDATE video_collection_state
        SET priority = 0,
            next_minute_due_at = NULL,
            updated_at = p_now
        WHERE priority > 0
          AND daily_delta_source = 'bootstrap'
          AND bootstrap_until IS NOT NULL
          AND bootstrap_until <= p_now
          AND latest_daily_delta IS NULL
          AND weekly_avg_daily_delta IS NULL
        RETURNING aid
      )
      UPDATE video_collection_queue q
      SET status = 'abandoned',
          locked_until = NULL,
          updated_at = p_now
      FROM expired_bootstrap eb
      WHERE q.aid = eb.aid
        AND q.task_type = 'minute'
        AND q.status IN ('pending', 'leased');

      UPDATE video_collection_queue
      SET status = 'abandoned',
          updated_at = p_now
      WHERE status = 'leased'
        AND locked_until <= p_now
        AND attempt_count >= max_attempts;

      PERFORM fn_advance_abandoned_minute_collection_state(p_now);

      WITH minute_candidates AS (
        SELECT
          s.aid,
          s.next_minute_due_at,
          concat('minute:', s.aid, ':', extract(epoch FROM s.next_minute_due_at)::bigint) AS dedupe_key
        FROM video_collection_state s
        WHERE s.priority > 0
          AND s.next_minute_due_at IS NOT NULL
          AND s.next_minute_due_at <= p_now
      )
      INSERT INTO video_collection_queue (
        aid,
        task_type,
        dedupe_key,
        due_at,
        max_attempts,
        updated_at
      )
      SELECT
        mc.aid,
        'minute',
        mc.dedupe_key,
        mc.next_minute_due_at,
        p_max_attempts,
        p_now
      FROM minute_candidates mc
      WHERE NOT EXISTS (
        SELECT 1
        FROM video_collection_queue q
        WHERE q.dedupe_key = mc.dedupe_key
          AND q.status IN ('pending', 'leased')
      )
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      RETURN inserted_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS fn_enqueue_video_collection_gate_tasks(
      timestamptz, interval, numeric, bigint, integer
    )
  `);

  // Gate detection is now reactive (triggers on video_minute / video_daily),
  // so the per-tick poll-based enqueue is replaced by a no-op stub.
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_enqueue_video_collection_gate_tasks(
      p_now timestamptz DEFAULT now(),
      p_gate_lead_time interval DEFAULT interval '30 minutes',
      p_gate_min_lead_ratio numeric DEFAULT 0.10,
      p_gate_max_lead_views bigint DEFAULT 500,
      p_max_attempts integer DEFAULT 5,
      p_business_timezone text DEFAULT 'Asia/Shanghai'
    ) RETURNS integer AS $$
    BEGIN
      RETURN 0;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_claim_video_collection_tasks(
      p_now timestamptz DEFAULT now(),
      p_limit integer DEFAULT 50,
      p_lock_duration interval DEFAULT interval '30 seconds'
    ) RETURNS TABLE (
      id bigint,
      aid bigint,
      task_type text,
      dedupe_key text,
      due_at timestamptz,
      locked_until timestamptz,
      attempt_count integer,
      gate_value bigint,
      gate_reason text
    ) AS $$
    BEGIN
      UPDATE video_collection_queue q
      SET status = 'abandoned',
          updated_at = p_now
      WHERE q.status = 'leased'
        AND q.locked_until <= p_now
        AND q.attempt_count >= q.max_attempts;

      PERFORM fn_advance_abandoned_minute_collection_state(p_now);

      RETURN QUERY
      WITH candidates AS (
        SELECT q.id
        FROM video_collection_queue q
        WHERE q.due_at <= p_now
          AND q.attempt_count < q.max_attempts
          AND (
            q.status = 'pending'
            OR (q.status = 'leased' AND q.locked_until <= p_now)
          )
        ORDER BY
          CASE WHEN q.task_type = 'minute' THEN 0 ELSE 1 END ASC,
          q.due_at ASC,
          q.id ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE video_collection_queue q
        SET status = 'leased',
            locked_until = p_now + p_lock_duration,
            attempt_count = q.attempt_count + 1,
            updated_at = p_now
        FROM candidates c
        WHERE q.id = c.id
        RETURNING q.id, q.aid, q.task_type, q.dedupe_key, q.due_at,
                  q.locked_until, q.attempt_count, q.gate_value, q.gate_reason
      )
      SELECT * FROM updated;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_ack_video_collection_tasks(
      p_task_ids bigint[],
      p_now timestamptz DEFAULT now()
    ) RETURNS integer AS $$
    DECLARE
      completed_count integer;
    BEGIN
      WITH leased AS (
        SELECT q.id, q.aid, q.gate_value
        FROM video_collection_queue q
        WHERE q.id = ANY(p_task_ids)
          AND q.status = 'leased'
      ),
      gate_leased AS (
        SELECT *
        FROM leased
        WHERE gate_value IS NOT NULL
      ),
      sample_pairs AS (
        SELECT
          g.id,
          g.aid,
          g.gate_value,
          latest."view"::bigint AS current_view,
          previous."view"::bigint AS previous_view
        FROM gate_leased g
        LEFT JOIN LATERAL (
          SELECT vm."view", vm."time"
          FROM video_minute vm
          WHERE vm.aid = g.aid
          ORDER BY vm."time" DESC
          LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT vm."view", vm."time"
          FROM video_minute vm
          WHERE vm.aid = g.aid
            AND latest."time" IS NOT NULL
            AND vm."time" < latest."time"
          ORDER BY vm."time" DESC
          LIMIT 1
        ) previous ON true
      ),
      gate_outcome AS (
        SELECT
          sp.*,
          COALESCE(sp.current_view >= sp.gate_value, false) AS crossed
        FROM sample_pairs sp
      ),
      completed AS (
        UPDATE video_collection_queue q
        SET status = 'completed',
            locked_until = NULL,
            updated_at = p_now
        FROM leased l
        LEFT JOIN gate_outcome go ON go.id = l.id
        WHERE q.id = l.id
          AND (
            l.gate_value IS NULL
            OR go.crossed
          )
        RETURNING q.id, q.aid, q.gate_value
      ),
      deferred_gate AS (
        UPDATE video_collection_queue q
        SET status = 'pending',
            due_at = p_now + make_interval(
              mins => least(greatest(COALESCE(s.priority, 5), 1), 5)
            ),
            attempt_count = greatest(q.attempt_count - 1, 0),
            locked_until = NULL,
            updated_at = p_now
        FROM gate_outcome go
        LEFT JOIN video_collection_state s ON s.aid = go.aid
        WHERE q.id = go.id
          AND q.status = 'leased'
          AND NOT go.crossed
        RETURNING q.id
      ),
      inserted_crossings AS (
        INSERT INTO video_collection_gate_crossings (
          aid,
          gate_value,
          previous_view,
          current_view,
          crossed_at,
          source_task_id
        )
        SELECT
          go.aid,
          go.gate_value,
          go.previous_view,
          go.current_view,
          p_now,
          go.id
        FROM gate_outcome go
        WHERE go.crossed
        ON CONFLICT (aid, gate_value) DO NOTHING
        RETURNING 1
      )
      SELECT count(*) INTO completed_count
      FROM (
        SELECT id FROM completed
        UNION ALL
        SELECT id FROM deferred_gate
      ) processed;

      RETURN completed_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_fail_video_collection_tasks(
      p_task_ids bigint[],
      p_now timestamptz DEFAULT now()
    ) RETURNS integer AS $$
    DECLARE
      failed_count integer;
    BEGIN
      UPDATE video_collection_queue q
      SET status = CASE
            WHEN q.attempt_count >= q.max_attempts THEN 'abandoned'
            ELSE 'pending'
          END,
          locked_until = NULL,
          updated_at = p_now
      WHERE q.id = ANY(p_task_ids)
        AND q.status = 'leased';

      GET DIAGNOSTICS failed_count = ROW_COUNT;

      PERFORM fn_advance_abandoned_minute_collection_state(p_now);

      RETURN failed_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  logger.info("video_collection_queue: schema ready");
}
