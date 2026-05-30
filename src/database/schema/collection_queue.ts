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
    CREATE TABLE IF NOT EXISTS video_collection_gate_crossings (
      id bigserial PRIMARY KEY,
      aid bigint NOT NULL,
      gate_value bigint NOT NULL,
      previous_view bigint,
      current_view bigint,
      crossed_at timestamptz NOT NULL DEFAULT now(),
      source_task_id bigint REFERENCES video_collection_queue(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_video_collection_gate_crossing UNIQUE (aid, gate_value)
    )
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_exact_gate_value(
      p_view bigint
    ) RETURNS bigint AS $$
    BEGIN
      IF p_view IS NULL OR p_view <= 0 THEN
        RETURN NULL;
      END IF;

      IF p_view < 10000 AND p_view % 1000 = 0 THEN
        RETURN p_view;
      END IF;

      IF p_view >= 10000 AND p_view % 10000 = 0 THEN
        RETURN p_view;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_next_gate_value(
      p_view bigint
    ) RETURNS bigint AS $$
    BEGIN
      IF p_view IS NULL OR p_view < 0 THEN
        RETURN NULL;
      END IF;

      IF p_view < 10000 THEN
        RETURN ((p_view / 1000) + 1) * 1000;
      END IF;

      RETURN ((p_view / 10000) + 1) * 10000;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_crossed_gate_value(
      p_previous_view bigint,
      p_current_view bigint
    ) RETURNS bigint AS $$
    DECLARE
      candidate bigint;
      crossed bigint := NULL;
    BEGIN
      IF p_previous_view IS NULL
        OR p_current_view IS NULL
        OR p_current_view <= p_previous_view
      THEN
        RETURN NULL;
      END IF;

      candidate := fn_video_collection_next_gate_value(p_previous_view);
      WHILE candidate IS NOT NULL AND candidate <= p_current_view LOOP
        crossed := candidate;
        candidate := fn_video_collection_next_gate_value(candidate);
      END LOOP;

      RETURN crossed;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_enqueue_video_collection_tasks(
      p_now timestamptz DEFAULT now(),
      p_max_attempts integer DEFAULT 5
    ) RETURNS integer AS $$
    DECLARE
      inserted_count integer;
    BEGIN
      UPDATE video_collection_queue
      SET status = 'abandoned',
          updated_at = p_now
      WHERE status = 'leased'
        AND locked_until <= p_now
        AND attempt_count >= max_attempts;

      INSERT INTO video_collection_queue (
        aid,
        task_type,
        dedupe_key,
        due_at,
        max_attempts,
        updated_at
      )
      SELECT
        s.aid,
        'minute',
        concat('minute:', s.aid, ':', extract(epoch FROM s.next_minute_due_at)::bigint),
        s.next_minute_due_at,
        p_max_attempts,
        p_now
      FROM video_collection_state s
      WHERE s.priority > 0
        AND s.next_minute_due_at IS NOT NULL
        AND s.next_minute_due_at <= p_now
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      RETURN inserted_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_enqueue_video_collection_gate_tasks(
      p_now timestamptz DEFAULT now(),
      p_gate_lead_time interval DEFAULT interval '30 minutes',
      p_gate_min_lead_ratio numeric DEFAULT 0.10,
      p_gate_max_lead_views bigint DEFAULT 500,
      p_max_attempts integer DEFAULT 5
    ) RETURNS integer AS $$
    DECLARE
      inserted_count integer;
    BEGIN
      WITH samples AS (
        SELECT aid, updated_at AS sample_time, "view"::bigint AS view_count
        FROM video_daily_latest
        WHERE "view" IS NOT NULL
        UNION ALL
        SELECT aid, record_date::timestamptz AS sample_time, "view"::bigint AS view_count
        FROM video_daily
        WHERE "view" IS NOT NULL
        UNION ALL
        SELECT aid, "time" AS sample_time, "view"::bigint AS view_count
        FROM video_minute
        WHERE "view" IS NOT NULL
      ),
      ranked AS (
        SELECT
          s.*,
          row_number() OVER (PARTITION BY aid ORDER BY sample_time DESC) AS rn
        FROM samples s
      ),
      paired AS (
        SELECT
          current_sample.aid,
          current_sample.sample_time AS current_sample_time,
          current_sample.view_count AS current_view,
          previous_sample.sample_time AS previous_sample_time,
          previous_sample.view_count AS previous_view,
          state.priority,
          state.next_minute_due_at
        FROM ranked current_sample
        JOIN video_collection_state state ON state.aid = current_sample.aid
        LEFT JOIN ranked previous_sample
          ON previous_sample.aid = current_sample.aid
         AND previous_sample.rn = 2
        WHERE current_sample.rn = 1
          AND state.priority <> -1
      ),
      candidates AS (
        SELECT
          p.*,
          fn_video_collection_exact_gate_value(p.current_view) AS exact_gate,
          fn_video_collection_crossed_gate_value(p.previous_view, p.current_view) AS crossed_gate,
          fn_video_collection_next_gate_value(p.current_view) AS next_gate,
          p.current_view - p.previous_view AS recent_delta,
          extract(epoch FROM (p.current_sample_time - p.previous_sample_time)) AS recent_seconds
        FROM paired p
      ),
      selected AS (
        SELECT
          c.aid,
          CASE
            WHEN c.exact_gate IS NOT NULL THEN c.exact_gate
            WHEN c.crossed_gate IS NOT NULL THEN c.crossed_gate
            WHEN c.next_gate IS NOT NULL
             AND c.recent_delta > 0
             AND c.recent_seconds > 0
             AND c.priority > 0
             AND c.next_minute_due_at IS NOT NULL
             AND c.current_view + (
               c.recent_delta
               * extract(epoch FROM (c.next_minute_due_at + p_gate_lead_time - c.current_sample_time))
               / c.recent_seconds
             ) >= c.next_gate THEN c.next_gate
            WHEN c.next_gate IS NOT NULL
             AND c.recent_delta > 0
             AND c.next_gate - c.current_view <= least(
               ceil(c.next_gate * p_gate_min_lead_ratio)::bigint,
               p_gate_max_lead_views
             ) THEN c.next_gate
            ELSE NULL
          END AS gate_value,
          CASE
            WHEN c.exact_gate IS NOT NULL THEN 'view_threshold'
            WHEN c.crossed_gate IS NOT NULL THEN 'crossed_threshold'
            WHEN c.next_gate IS NOT NULL
             AND c.recent_delta > 0
             AND c.recent_seconds > 0
             AND c.priority > 0
             AND c.next_minute_due_at IS NOT NULL
             AND c.current_view + (
               c.recent_delta
               * extract(epoch FROM (c.next_minute_due_at + p_gate_lead_time - c.current_sample_time))
               / c.recent_seconds
             ) >= c.next_gate THEN 'predicted_threshold'
            ELSE 'near_threshold'
          END AS gate_reason
        FROM candidates c
      )
      INSERT INTO video_collection_queue (
        aid,
        task_type,
        dedupe_key,
        due_at,
        max_attempts,
        gate_value,
        gate_reason,
        updated_at
      )
      SELECT
        s.aid,
        'gate',
        concat('gate:', s.aid, ':', s.gate_value),
        p_now,
        p_max_attempts,
        s.gate_value,
        s.gate_reason,
        p_now
      FROM selected s
      WHERE s.gate_value IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM video_collection_gate_crossings c
          WHERE c.aid = s.aid
            AND c.gate_value = s.gate_value
        )
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      RETURN inserted_count;
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
      UPDATE video_collection_queue
      SET status = 'abandoned',
          updated_at = p_now
      WHERE status = 'leased'
        AND locked_until <= p_now
        AND attempt_count >= max_attempts;

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
          CASE WHEN q.task_type = 'gate' THEN 0 ELSE 1 END,
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
      WITH completed AS (
        UPDATE video_collection_queue q
        SET status = 'completed',
            locked_until = NULL,
            updated_at = p_now
        WHERE q.id = ANY(p_task_ids)
          AND q.status = 'leased'
        RETURNING q.id, q.aid, q.gate_value
      ),
      gate_completed AS (
        SELECT *
        FROM completed
        WHERE gate_value IS NOT NULL
      ),
      sample_pairs AS (
        SELECT
          g.id,
          g.aid,
          g.gate_value,
          latest."view"::bigint AS current_view,
          previous."view"::bigint AS previous_view
        FROM gate_completed g
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
          sp.aid,
          sp.gate_value,
          sp.previous_view,
          sp.current_view,
          p_now,
          sp.id
        FROM sample_pairs sp
        WHERE sp.gate_value IS NOT NULL
        ON CONFLICT (aid, gate_value) DO NOTHING
        RETURNING 1
      )
      SELECT count(*) INTO completed_count FROM completed;

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
      RETURN failed_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  logger.info("video_collection_queue: schema ready");
}
