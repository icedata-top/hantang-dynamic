import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

function sqlText(value: string): string {
  return value.split("'").join("''");
}

function sqlTextArray(values: string[]): string {
  return values.map((value) => `'${sqlText(value)}'`).join(", ");
}

function sqlIntegerArray(values: number[]): string {
  return values.join(", ");
}

export async function initCollectionStateSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_collection_state (
      aid bigint PRIMARY KEY,
      latest_daily_delta bigint,
      weekly_avg_daily_delta numeric,
      daily_delta_source text NOT NULL,
      priority integer NOT NULL DEFAULT 0,
      bootstrap_until timestamptz,
      next_minute_due_at timestamptz,
      last_minute_success_at timestamptz,
      last_daily_record_date date,
      last_view bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_video_collection_daily_delta_source
        CHECK (daily_delta_source IN ('daily_delta', 'weekly_avg', 'bootstrap', 'processed_backfill')),
      CONSTRAINT chk_video_collection_priority_valid
        CHECK (priority IN (-2, -1, 0) OR priority BETWEEN 1 AND 720)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_state_minute_due
    ON video_collection_state(next_minute_due_at, aid)
    WHERE priority > 0
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_collection_state_daily
    ON video_collection_state(priority, last_daily_record_date, aid)
  `);

  // Add next_gate_value column (reactive gate detection)
  await pool.query(`
    ALTER TABLE video_collection_state
    ADD COLUMN IF NOT EXISTS next_gate_value bigint
  `);

  // Track when the view count last changed (= last observed B站 counter refresh).
  // Used by advanceUnchangedMinuteVideos to predict the next refresh and
  // switch to 1-second polling right before it happens.
  await pool.query(`
    ALTER TABLE video_collection_state
    ADD COLUMN IF NOT EXISTS last_view_change_at timestamptz
  `);

  // B站 view counters refresh roughly every 75 s (varies 60-90 s).
  // Polling faster than that just retrieves stale values, so the effective
  // base interval is floored to 75 s.  Only affects priority = 1
  // (60 s → 75 s); priority ≥ 2 (120 s) already exceeds the floor.
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_interval_secs(
      p_priority integer
    ) RETURNS integer AS $$
      SELECT greatest(p_priority * 60, 75)
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_next_due_at(
      p_aid bigint,
      p_priority integer,
      p_now timestamptz DEFAULT now()
    ) RETURNS timestamptz AS $$
      SELECT CASE
        WHEN p_priority IS NULL OR p_priority <= 0 THEN NULL
        ELSE (
          SELECT CASE WHEN cand < p_now
            THEN cand + make_interval(secs => fn_video_collection_interval_secs(p_priority))
            ELSE cand
          END
          FROM (
            SELECT to_timestamp(
              floor(extract(epoch FROM p_now) / fn_video_collection_interval_secs(p_priority))
                * fn_video_collection_interval_secs(p_priority)
            ) + make_interval(mins => (abs(p_aid) % p_priority)::integer) AS cand
          ) t
        )
      END
    $$ LANGUAGE sql STABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_priority(
      p_daily_delta numeric,
      p_target_delta_per_sample integer DEFAULT ${config.minute.targetDeltaPerSample},
      p_target_delta_lower integer DEFAULT ${config.minute.targetDeltaLower},
      p_target_delta_upper integer DEFAULT ${config.minute.targetDeltaUpper},
      p_min_positive_priority integer DEFAULT ${config.minute.minPositivePriority},
      p_max_positive_priority integer DEFAULT ${config.minute.maxPositivePriority}
    ) RETURNS integer AS $$
      SELECT CASE
        WHEN p_daily_delta IS NULL OR p_daily_delta <= 0 THEN 0
        ELSE least(
          greatest(
            round(
              least(
                greatest(p_target_delta_per_sample, p_target_delta_lower),
                p_target_delta_upper
              ) * 1440.0 / p_daily_delta
            )::integer,
            p_min_positive_priority
          ),
          p_max_positive_priority
        )
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_priority(
      p_daily_delta bigint,
      p_target_delta_per_sample integer DEFAULT ${config.minute.targetDeltaPerSample},
      p_target_delta_lower integer DEFAULT ${config.minute.targetDeltaLower},
      p_target_delta_upper integer DEFAULT ${config.minute.targetDeltaUpper},
      p_min_positive_priority integer DEFAULT ${config.minute.minPositivePriority},
      p_max_positive_priority integer DEFAULT ${config.minute.maxPositivePriority}
    ) RETURNS integer AS $$
      SELECT CASE
        WHEN p_daily_delta IS NULL OR p_daily_delta <= 0 THEN 0
        ELSE least(
          greatest(
            round(
              least(
                greatest(p_target_delta_per_sample, p_target_delta_lower),
                p_target_delta_upper
              ) * 1440e0 / p_daily_delta
            )::integer,
            p_min_positive_priority
          ),
          p_max_positive_priority
        )
      END
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_priority(
      p_daily_delta numeric
    ) RETURNS integer AS $$
      SELECT fn_video_collection_priority(
        p_daily_delta,
        ${config.minute.targetDeltaPerSample},
        ${config.minute.targetDeltaLower},
        ${config.minute.targetDeltaUpper},
        ${config.minute.minPositivePriority},
        ${config.minute.maxPositivePriority}
      )
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_refresh_video_collection_state_from_daily(
      p_aids bigint[] DEFAULT NULL,
      p_now timestamptz DEFAULT now(),
      p_target_delta_per_sample integer DEFAULT ${config.minute.targetDeltaPerSample},
      p_target_delta_lower integer DEFAULT ${config.minute.targetDeltaLower},
      p_target_delta_upper integer DEFAULT ${config.minute.targetDeltaUpper},
      p_min_positive_priority integer DEFAULT ${config.minute.minPositivePriority},
      p_max_positive_priority integer DEFAULT ${config.minute.maxPositivePriority},
      p_business_timezone text DEFAULT '${sqlText(config.minute.collectionBusinessTimezone)}'
    ) RETURNS integer AS $$
    DECLARE
      changed_count integer;
      v_today          date;
      v_yesterday      date;
      v_seven_days_ago date;
    BEGIN
      v_today          := (p_now AT TIME ZONE p_business_timezone)::date;
      v_yesterday      := v_today - 1;
      v_seven_days_ago := v_today - 7;

      SET LOCAL work_mem = '256MB';

      WITH daily_snapshot AS (
        SELECT vd.aid, vd.record_date, vd."view"::bigint AS vw
        FROM video_daily vd
        WHERE vd.record_date IN (v_today, v_yesterday, v_seven_days_ago)
          AND p_aids IS NULL

        UNION ALL

        SELECT vd.aid, vd.record_date, vd."view"::bigint
        FROM unnest(p_aids) AS req(aid)
        JOIN video_daily vd
          ON vd.aid = req.aid
         AND vd.record_date IN (v_today, v_yesterday, v_seven_days_ago)
        WHERE p_aids IS NOT NULL
      ),
      measured AS (
        SELECT
          agg.aid,
          agg.current_view,
          agg.previous_view,
          agg.seven_day_view,
          CASE WHEN agg.previous_view IS NOT NULL
            THEN greatest(agg.current_view - agg.previous_view, 0)
          END AS daily_delta,
          CASE WHEN agg.seven_day_view IS NOT NULL
            THEN greatest(agg.current_view - agg.seven_day_view, 0) / 7
          END AS weekly_delta
        FROM (
          SELECT
            ds.aid,
            max(ds.vw) FILTER (WHERE ds.record_date = v_today)          AS current_view,
            max(ds.vw) FILTER (WHERE ds.record_date = v_yesterday)      AS previous_view,
            max(ds.vw) FILTER (WHERE ds.record_date = v_seven_days_ago) AS seven_day_view
          FROM daily_snapshot ds
          GROUP BY ds.aid
          HAVING max(ds.vw) FILTER (WHERE ds.record_date = v_today) IS NOT NULL
        ) agg
      ),
      calculated AS (
        SELECT
          m.aid,
          m.daily_delta  AS latest_daily_delta,
          m.weekly_delta AS weekly_avg_daily_delta,
          CASE
            WHEN m.daily_delta  IS NOT NULL THEN 'daily_delta'
            WHEN m.weekly_delta IS NOT NULL THEN 'weekly_avg'
            ELSE 'processed_backfill'
          END AS daily_delta_source,
          CASE
            WHEN m.seven_day_view IS NOT NULL AND m.current_view = m.seven_day_view THEN -2
            WHEN COALESCE(m.daily_delta, 0) > 100 THEN
              fn_video_collection_priority(
                m.daily_delta,
                p_target_delta_per_sample, p_target_delta_lower,
                p_target_delta_upper, p_min_positive_priority, p_max_positive_priority)
            WHEN COALESCE(m.weekly_delta, 0) >= 100 THEN
              fn_video_collection_priority(
                m.weekly_delta,
                p_target_delta_per_sample, p_target_delta_lower,
                p_target_delta_upper, p_min_positive_priority, p_max_positive_priority)
            WHEN m.seven_day_view IS NOT NULL AND m.current_view > m.seven_day_view THEN 0
            ELSE 0
          END AS priority,
          m.current_view AS last_view,
          m.previous_view,
          fn_video_collection_next_gate_value(m.current_view) AS next_gate_value,
          fn_video_collection_crossed_gate_value(m.previous_view, m.current_view) AS crossed_gate
        FROM measured m
      ),
      -- Record daily-level gate crossings.
      -- For minute-sampled videos the minute trigger usually records crossings
      -- first; ON CONFLICT (aid, gate_value) DO NOTHING deduplicates.
      -- No JOIN on video_collection_state — the state row may not exist yet
      -- for new videos (the main INSERT below creates it).
      daily_crossings AS (
        INSERT INTO video_collection_gate_crossings (
          aid, gate_value, previous_view, current_view, crossed_at
        )
        SELECT
          c.aid,
          c.crossed_gate,
          c.previous_view,
          c.last_view,
          p_now
        FROM calculated c
        WHERE c.crossed_gate IS NOT NULL
        ON CONFLICT (aid, gate_value) DO NOTHING
        RETURNING aid
      )
      INSERT INTO video_collection_state (
        aid, latest_daily_delta, weekly_avg_daily_delta, daily_delta_source,
        priority, next_minute_due_at, last_daily_record_date, last_view,
        next_gate_value, updated_at
      )
      SELECT
        c.aid, c.latest_daily_delta, c.weekly_avg_daily_delta, c.daily_delta_source,
        c.priority,
        CASE WHEN c.priority > 0
          THEN fn_video_collection_next_due_at(c.aid, c.priority, p_now)
        END,
        v_today,
        c.last_view,
        c.next_gate_value,
        p_now
      FROM calculated c
      ON CONFLICT (aid) DO UPDATE SET
        latest_daily_delta     = EXCLUDED.latest_daily_delta,
        weekly_avg_daily_delta = EXCLUDED.weekly_avg_daily_delta,
        daily_delta_source = CASE
          WHEN EXCLUDED.latest_daily_delta IS NULL
           AND EXCLUDED.weekly_avg_daily_delta IS NULL
          THEN video_collection_state.daily_delta_source
          ELSE EXCLUDED.daily_delta_source
        END,
        priority = CASE
          WHEN video_collection_state.priority = -1 THEN -1
          ELSE EXCLUDED.priority
        END,
        next_minute_due_at = CASE
          WHEN video_collection_state.priority = -1 THEN NULL
          WHEN EXCLUDED.priority > 0
           AND (video_collection_state.next_minute_due_at IS NULL
             OR video_collection_state.priority IS DISTINCT FROM EXCLUDED.priority)
          THEN EXCLUDED.next_minute_due_at
          WHEN EXCLUDED.priority > 0 THEN video_collection_state.next_minute_due_at
          ELSE NULL
        END,
        bootstrap_until = CASE
          WHEN EXCLUDED.latest_daily_delta IS NOT NULL
            OR EXCLUDED.weekly_avg_daily_delta IS NOT NULL
          THEN NULL
          ELSE video_collection_state.bootstrap_until
        END,
        last_daily_record_date = EXCLUDED.last_daily_record_date,
        last_view              = COALESCE(greatest(EXCLUDED.last_view, video_collection_state.last_view), EXCLUDED.last_view, video_collection_state.last_view),
        next_gate_value        = CASE
          WHEN EXCLUDED.last_view >= COALESCE(video_collection_state.last_view, 0)
          THEN EXCLUDED.next_gate_value
          ELSE video_collection_state.next_gate_value
        END,
        updated_at             = p_now;

      GET DIAGNOSTICS changed_count = ROW_COUNT;
      RETURN changed_count;
    END;
    $$ LANGUAGE plpgsql PARALLEL SAFE
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS fn_refresh_video_collection_state_from_daily(bigint[], timestamptz)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_upsert_collection_state_from_processed_video(
      p_aid bigint,
      p_pubdate bigint DEFAULT NULL,
      p_ctime bigint DEFAULT NULL,
      p_tid_v2 integer DEFAULT NULL,
      p_label_content_type text DEFAULT NULL,
      p_label_origin text DEFAULT NULL,
      p_labeled_by text DEFAULT NULL,
      p_is_deleted boolean DEFAULT false,
      p_is_filtered boolean DEFAULT NULL,
      p_now timestamptz DEFAULT now(),
      p_bootstrap_priority integer DEFAULT ${config.minute.bootstrapPriority},
      p_bootstrap_ttl_hours integer DEFAULT ${config.minute.bootstrapTtlHours},
      p_bootstrap_label_content_types text[] DEFAULT ARRAY[${sqlTextArray(config.minute.bootstrapLabelContentTypes)}]::text[],
      p_bootstrap_label_origin text DEFAULT '${sqlText(config.minute.bootstrapLabelOrigin)}',
      p_bootstrap_label_writers text[] DEFAULT ARRAY[${sqlTextArray(config.minute.bootstrapLabelWriters)}]::text[],
      p_bootstrap_tid_v2_allowlist integer[] DEFAULT ARRAY[${sqlIntegerArray(config.minute.bootstrapTidV2Allowlist)}]::integer[],
      p_processed_backfill_new_video_age_days integer DEFAULT ${config.minute.processedBackfillNewVideoAgeDays}
    ) RETURNS text AS $$
    DECLARE
      has_existing boolean;
      existing_priority integer;
      has_daily_history boolean;
      has_formal_label_input boolean;
      has_complete_formal_label_input boolean;
      formal_label_pass boolean;
      fallback_pass boolean;
      should_track boolean;
      video_timestamp timestamptz;
      is_new_video boolean;
      refresh_count integer;
    BEGIN
      IF p_aid IS NULL OR p_aid < 0 THEN
        RETURN 'ignored_invalid_aid';
      END IF;

      SELECT priority
      INTO existing_priority
      FROM video_collection_state
      WHERE aid = p_aid;
      has_existing := found;

      IF p_is_deleted IS TRUE THEN
        IF has_existing THEN
          UPDATE video_collection_state
          SET priority = -1,
              next_minute_due_at = NULL,
              updated_at = p_now
          WHERE aid = p_aid;
          RETURN 'disabled_deleted';
        END IF;
        RETURN 'ignored_deleted';
      END IF;

      IF has_existing AND existing_priority = -1 THEN
        RETURN 'ignored_existing_disabled';
      END IF;

      IF p_is_filtered IS FALSE THEN
        IF has_existing THEN
          UPDATE video_collection_state
          SET priority = -1,
              next_minute_due_at = NULL,
              updated_at = p_now
          WHERE aid = p_aid;
          RETURN 'disabled_filtered_out';
        END IF;
        RETURN 'ignored_filtered_out';
      END IF;

      has_formal_label_input :=
        p_label_content_type IS NOT NULL
        OR p_label_origin IS NOT NULL
        OR p_labeled_by IS NOT NULL;
      has_complete_formal_label_input :=
        p_label_content_type IS NOT NULL
        AND p_label_origin IS NOT NULL
        AND p_labeled_by IS NOT NULL;
      formal_label_pass := COALESCE(
        p_label_content_type = ANY(p_bootstrap_label_content_types)
        AND p_label_origin = p_bootstrap_label_origin
        AND p_labeled_by = ANY(p_bootstrap_label_writers),
        false
      );
      fallback_pass :=
        NOT has_formal_label_input
        AND p_tid_v2 = ANY(p_bootstrap_tid_v2_allowlist);
      should_track := COALESCE(formal_label_pass OR fallback_pass, false);

      IF has_complete_formal_label_input AND NOT formal_label_pass THEN
        IF has_existing THEN
          UPDATE video_collection_state
          SET priority = -1,
              next_minute_due_at = NULL,
              updated_at = p_now
          WHERE aid = p_aid;
          RETURN 'disabled_label_demotion';
        END IF;
        RETURN 'ignored_label_demotion';
      END IF;

      IF NOT should_track THEN
        RETURN 'ignored_label_not_ready';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM video_daily WHERE aid = p_aid
      ) INTO has_daily_history;

      IF has_daily_history THEN
        SELECT fn_refresh_video_collection_state_from_daily(ARRAY[p_aid], p_now)
        INTO refresh_count;
        RETURN 'refreshed_from_daily';
      END IF;

      video_timestamp := to_timestamp(COALESCE(p_pubdate, p_ctime, extract(epoch FROM p_now)::bigint));
      is_new_video := video_timestamp >= p_now - make_interval(days => p_processed_backfill_new_video_age_days);

      INSERT INTO video_collection_state (
        aid,
        daily_delta_source,
        priority,
        bootstrap_until,
        next_minute_due_at,
        updated_at
      )
      VALUES (
        p_aid,
        CASE WHEN is_new_video THEN 'bootstrap' ELSE 'processed_backfill' END,
        CASE WHEN is_new_video THEN p_bootstrap_priority ELSE 0 END,
        CASE
          WHEN is_new_video THEN p_now + make_interval(hours => least(p_bootstrap_ttl_hours, 24))
          ELSE NULL
        END,
        CASE
          WHEN is_new_video THEN fn_video_collection_next_due_at(p_aid, p_bootstrap_priority, p_now)
          ELSE NULL
        END,
        p_now
      )
      ON CONFLICT (aid) DO UPDATE SET
        daily_delta_source = CASE
          WHEN video_collection_state.daily_delta_source = 'bootstrap'
            OR video_collection_state.daily_delta_source = 'processed_backfill'
          THEN EXCLUDED.daily_delta_source
          ELSE video_collection_state.daily_delta_source
        END,
        priority = CASE
          WHEN video_collection_state.priority = -1 THEN -1
          ELSE video_collection_state.priority
        END,
        bootstrap_until = COALESCE(video_collection_state.bootstrap_until, EXCLUDED.bootstrap_until),
        next_minute_due_at = COALESCE(video_collection_state.next_minute_due_at, EXCLUDED.next_minute_due_at),
        updated_at = p_now;

      RETURN CASE WHEN is_new_video THEN 'upserted_bootstrap' ELSE 'upserted_backfill_daily_only' END;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_upsert_collection_state_from_processed_video(
      p_aid bigint,
      p_pubdate bigint,
      p_ctime bigint,
      p_tid_v2 integer,
      p_label_content_type text,
      p_label_origin text,
      p_labeled_by text,
      p_is_deleted boolean,
      p_is_filtered boolean,
      p_now timestamptz
    ) RETURNS text AS $$
    BEGIN
      RETURN fn_upsert_collection_state_from_processed_video(
        p_aid,
        p_pubdate,
        p_ctime,
        p_tid_v2,
        p_label_content_type,
        p_label_origin,
        p_labeled_by,
        p_is_deleted,
        p_is_filtered,
        p_now,
        ${config.minute.bootstrapPriority},
        ${config.minute.bootstrapTtlHours},
        ARRAY[${sqlTextArray(config.minute.bootstrapLabelContentTypes)}]::text[],
        '${sqlText(config.minute.bootstrapLabelOrigin)}',
        ARRAY[${sqlTextArray(config.minute.bootstrapLabelWriters)}]::text[],
        ARRAY[${sqlIntegerArray(config.minute.bootstrapTidV2Allowlist)}]::integer[],
        ${config.minute.processedBackfillNewVideoAgeDays}
      );
    END;
    $$ LANGUAGE plpgsql
  `);

  // For the dynamic-sleep handler loop: find the nearest *future* due time.
  // Returns NULL if no active videos exist (or all are already past-due).
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_next_minute_due_at(
      p_now timestamptz DEFAULT now()
    ) RETURNS timestamptz AS $$
      SELECT min(next_minute_due_at)
      FROM video_collection_state
      WHERE priority > 0
        AND next_minute_due_at IS NOT NULL
        AND next_minute_due_at > p_now
    $$ LANGUAGE sql STABLE
  `);

  // ── Queue-free minute collection ──────────────────────────────────
  // Replaces the enqueue→claim→ack/fail cycle on video_collection_queue.
  // Single consumer + reactive gate triggers make the queue unnecessary.

  // Select videos due for minute sampling.
  // Returns (aid, last_view, near_gate, due_at) — the handler uses near_gate
  // and due_at to implement batch-accumulation: non-gate videos are held
  // until the batch is full (50), 30 s have elapsed, or a gate video appears.
  // Single-consumer architecture: no row locking needed.
  await pool.query(`
    DROP FUNCTION IF EXISTS fn_select_due_minute_videos(timestamptz, integer)
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_select_due_minute_videos(
      p_now timestamptz DEFAULT now(),
      p_limit integer DEFAULT 50
    ) RETURNS TABLE (aid bigint, last_view bigint, near_gate boolean, due_at timestamptz) AS $$
    BEGIN
      -- Expire bootstrap entries that never got daily data
      UPDATE video_collection_state
      SET priority = 0,
          next_minute_due_at = NULL,
          updated_at = p_now
      WHERE priority > 0
        AND daily_delta_source = 'bootstrap'
        AND bootstrap_until IS NOT NULL
        AND bootstrap_until <= p_now
        AND latest_daily_delta IS NULL
        AND weekly_avg_daily_delta IS NULL;

      RETURN QUERY
      SELECT s.aid, s.last_view,
        -- A video is "near gate" (time-critical) when its actual scheduled
        -- interval has been compressed below its normal priority-based
        -- interval (priority × 60 s).  Gate-proximity acceleration and
        -- burst-mode are the only code paths that shorten the interval
        -- below that baseline, so this test is equivalent to "the system
        -- is actively accelerating this video toward a gate crossing."
        -- First-ever samples (last_minute_success_at IS NULL) have no
        -- acceleration history and are never time-critical.
        (s.last_minute_success_at IS NOT NULL
          AND extract(epoch from s.next_minute_due_at - s.last_minute_success_at)
              BETWEEN 0 AND fn_video_collection_interval_secs(s.priority) - 1
        ) AS near_gate,
        s.next_minute_due_at AS due_at
      FROM video_collection_state s
      WHERE s.priority > 0
        AND s.next_minute_due_at IS NOT NULL
        AND s.next_minute_due_at <= p_now
      ORDER BY s.next_minute_due_at ASC, s.aid ASC
      LIMIT p_limit;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_advance_failed_minute_videos(
      p_aids bigint[],
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
              s.next_minute_due_at + make_interval(secs => fn_video_collection_interval_secs(s.priority))
            )
          ),
          updated_at = p_now
      WHERE s.aid = ANY(p_aids)
        AND s.priority > 0
        AND s.next_minute_due_at IS NOT NULL;

      GET DIAGNOSTICS advanced_count = ROW_COUNT;
      RETURN advanced_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  // For samples where view count didn't change (B站 ~75s refresh window).
  // Three scheduling phases:
  //   1. Normal: maintain current interval
  //   2. Pre-burst: jump to predicted burst window start
  //   3. Burst: 1-second polling to catch exact B站 refresh second
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_advance_unchanged_minute_videos(
      p_aids bigint[],
      p_now timestamptz DEFAULT now()
    ) RETURNS integer AS $$
    DECLARE
      advanced_count integer;
    BEGIN
      WITH state_data AS (
        SELECT
          s.aid,
          COALESCE(extract(epoch from p_now - s.last_view_change_at), 9999)::numeric
            AS secs_since_change,
          greatest(
            COALESCE(extract(epoch from p_now - s.last_minute_success_at), fn_video_collection_interval_secs(s.priority)),
            5
          )::numeric
            AS maintain_secs,
          s.last_view_change_at + interval '55 seconds'
            AS burst_start,
          (s.next_gate_value IS NOT NULL
            AND s.last_view IS NOT NULL
            AND s.next_gate_value > s.last_view)
            AS near_gate
        FROM video_collection_state s
        WHERE s.aid = ANY(p_aids)
          AND s.priority > 0
          AND s.next_minute_due_at IS NOT NULL
      )
      UPDATE video_collection_state s
      SET next_minute_due_at = CASE
            -- Phase 3: In burst window (55-120s since last B站 refresh).
            -- 1-second polling to capture the exact refresh second.
            -- B站 refresh varies ~60-90s; cap at 120s to handle outliers.
            WHEN d.near_gate
             AND d.secs_since_change >= 55
             AND d.secs_since_change < 120
            THEN p_now + interval '1 second'

            -- Phase 2: Burst window starts before next maintain-interval sample.
            -- Jump directly to burst start instead of waiting.
            WHEN d.near_gate
             AND d.burst_start > p_now
             AND d.burst_start < p_now + d.maintain_secs * interval '1 second'
            THEN d.burst_start

            -- Phase 1: Normal — maintain current interval.
            ELSE p_now + d.maintain_secs * interval '1 second'
          END,
          last_minute_success_at = p_now,
          updated_at = p_now
      FROM state_data d
      WHERE s.aid = d.aid;

      GET DIAGNOSTICS advanced_count = ROW_COUNT;
      RETURN advanced_count;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_apply_video_minute_collection_update()
    RETURNS trigger AS $$
    BEGIN
      WITH latest_rows AS (
        SELECT DISTINCT ON (aid)
          aid,
          "time",
          "view"::bigint AS latest_view
        FROM new_video_minute_rows
        ORDER BY aid, "time" DESC
      ),
      computed AS (
        SELECT
          s.aid,
          l."time",
          l.latest_view,
          s.next_gate_value,
          p.previous_view,
          p.previous_time,
          -- Seconds since last sample
          COALESCE(extract(epoch from l."time" - p.previous_time), 0)::numeric
            AS sample_secs,
          -- View delta since last sample
          greatest(l.latest_view - COALESCE(p.previous_view, l.latest_view), 0)
            AS delta,
          -- Distance to next gate (NULL if no gate or already crossed)
          CASE WHEN s.next_gate_value IS NOT NULL
                AND l.latest_view < s.next_gate_value
            THEN (s.next_gate_value - l.latest_view)::numeric
          END AS gate_dist,
          -- Gate crossing: did this sample cross the next gate?
          CASE
            WHEN s.next_gate_value IS NOT NULL
             AND l.latest_view >= s.next_gate_value
            THEN s.next_gate_value
          END AS crossed_gate,
          -- Priority: only burst modifies this (near-gate does NOT touch priority)
          CASE
            WHEN s.priority = -1 THEN -1
            WHEN p.previous_view IS NOT NULL
             AND l.latest_view - p.previous_view >= ${config.minute.minuteBurstDeltaThreshold}
            THEN CASE
              WHEN s.priority > 0 THEN least(s.priority, ${config.minute.minuteBurstPriority})
              ELSE ${config.minute.minuteBurstPriority}
            END
            ELSE s.priority
          END AS next_priority,
          fn_video_collection_next_gate_value(l.latest_view) AS new_next_gate
        FROM video_collection_state s
        JOIN latest_rows l ON l.aid = s.aid
        LEFT JOIN LATERAL (
          SELECT vm."view"::bigint AS previous_view,
                 vm."time"         AS previous_time
          FROM video_minute vm
          WHERE vm.aid = l.aid
            AND vm."time" < l."time"
          ORDER BY vm."time" DESC
          LIMIT 1
        ) p ON true
      ),
      gate_crossings_recorded AS (
        INSERT INTO video_collection_gate_crossings (
          aid, gate_value, previous_view, current_view, crossed_at
        )
        SELECT c.aid, c.crossed_gate, c.previous_view, c.latest_view, c."time"
        FROM computed c
        WHERE c.crossed_gate IS NOT NULL
        ON CONFLICT (aid, gate_value) DO NOTHING
        RETURNING aid, gate_value
      )
      UPDATE video_collection_state s
      SET last_minute_success_at = c."time",
          last_view = c.latest_view,
          last_view_change_at = c."time",
          priority = c.next_priority,
          next_minute_due_at = CASE
            WHEN c.next_priority <= 0 THEN NULL

            -- Near gate + observed growth → progressive acceleration
            -- interval = est_seconds_to_gate / 3, clamped to [5s, priority interval]
            WHEN c.gate_dist IS NOT NULL
             AND c.delta > 0
             AND c.sample_secs > 0
            THEN c."time" + least(
                greatest(c.gate_dist / c.delta * c.sample_secs / 3, 5),
                fn_video_collection_interval_secs(c.next_priority)
              ) * interval '1 second'

            -- Normal schedule: find the next grid-aligned slot strictly after
            -- the sample time.  This avoids two problems at once:
            --   • batch-accumulation delay does not cascade (grid is fixed)
            --   • handler outage does not cause catch-up storms (skips ahead)
            ELSE fn_video_collection_next_due_at(s.aid, c.next_priority, c."time" + interval '1 second')
          END,
          next_gate_value = c.new_next_gate,
          updated_at = now()
      FROM computed c
      WHERE s.aid = c.aid;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_video_minute_collection_state ON video_minute
  `);
  await pool.query(`
    CREATE TRIGGER trg_video_minute_collection_state
    AFTER INSERT ON video_minute
    REFERENCING NEW TABLE AS new_video_minute_rows
    FOR EACH STATEMENT EXECUTE FUNCTION fn_apply_video_minute_collection_update()
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_apply_video_daily_collection_update()
    RETURNS trigger AS $$
    DECLARE
      affected_aids bigint[];
    BEGIN
      SELECT array_agg(DISTINCT aid) INTO affected_aids
      FROM new_video_daily_rows;
      PERFORM fn_refresh_video_collection_state_from_daily(affected_aids, now());
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_video_daily_collection_state ON video_daily
  `);
  await pool.query(`
    CREATE TRIGGER trg_video_daily_collection_state
    AFTER INSERT ON video_daily
    REFERENCING NEW TABLE AS new_video_daily_rows
    FOR EACH STATEMENT EXECUTE FUNCTION fn_apply_video_daily_collection_update()
  `);

  logger.info("video_collection_state: schema ready");
}
