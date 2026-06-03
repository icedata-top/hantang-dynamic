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

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_next_due_at(
      p_aid bigint,
      p_priority integer,
      p_now timestamptz DEFAULT now()
    ) RETURNS timestamptz AS $$
    DECLARE
      seconds_per_period numeric;
      base_epoch numeric;
      candidate timestamptz;
      offset_minutes integer;
    BEGIN
      IF p_priority IS NULL OR p_priority <= 0 THEN
        RETURN NULL;
      END IF;

      seconds_per_period := p_priority * 60;
      base_epoch := floor(extract(epoch FROM p_now) / seconds_per_period) * seconds_per_period;
      offset_minutes := (abs(p_aid) % p_priority)::integer;
      candidate := to_timestamp(base_epoch) + make_interval(mins => offset_minutes);

      IF candidate < p_now THEN
        candidate := candidate + make_interval(mins => p_priority);
      END IF;

      RETURN candidate;
    END;
    $$ LANGUAGE plpgsql STABLE
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
    DECLARE
      effective_target integer;
      calculated integer;
    BEGIN
      IF p_daily_delta IS NULL OR p_daily_delta <= 0 THEN
        RETURN 0;
      END IF;

      effective_target := least(
        greatest(p_target_delta_per_sample, p_target_delta_lower),
        p_target_delta_upper
      );
      calculated := round(effective_target * 1440.0 / p_daily_delta);
      RETURN least(
        greatest(calculated, p_min_positive_priority),
        p_max_positive_priority
      );
    END;
    $$ LANGUAGE plpgsql IMMUTABLE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_video_collection_priority(
      p_daily_delta numeric
    ) RETURNS integer AS $$
    BEGIN
      RETURN fn_video_collection_priority(
        p_daily_delta,
        ${config.minute.targetDeltaPerSample},
        ${config.minute.targetDeltaLower},
        ${config.minute.targetDeltaUpper},
        ${config.minute.minPositivePriority},
        ${config.minute.maxPositivePriority}
      );
    END;
    $$ LANGUAGE plpgsql IMMUTABLE
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
    BEGIN
      WITH target_dates AS (
        SELECT
          (p_now AT TIME ZONE p_business_timezone)::date AS today,
          ((p_now AT TIME ZONE p_business_timezone)::date - 1) AS yesterday,
          ((p_now AT TIME ZONE p_business_timezone)::date - 7) AS seven_days_ago
      ),
      target_date_values AS (
        SELECT today AS record_date, 'today'::text AS date_role FROM target_dates
        UNION ALL
        SELECT yesterday, 'yesterday'::text FROM target_dates
        UNION ALL
        SELECT seven_days_ago, 'seven_days_ago'::text FROM target_dates
      ),
      daily_window AS (
        SELECT
          vd.aid,
          tdv.date_role,
          vd."view"::bigint AS view_count
        FROM video_daily vd
        JOIN target_date_values tdv ON tdv.record_date = vd.record_date
        WHERE p_aids IS NULL
        UNION ALL
        SELECT
          vd.aid,
          tdv.date_role,
          vd."view"::bigint AS view_count
        FROM (
          SELECT DISTINCT requested_aid AS aid
          FROM unnest(p_aids) AS requested_aids(requested_aid)
        ) requested
        CROSS JOIN target_date_values tdv
        JOIN video_daily vd
          ON vd.aid = requested.aid
         AND vd.record_date = tdv.record_date
        WHERE p_aids IS NOT NULL
      ),
      measured AS (
        SELECT
          dw.aid,
          td.today AS record_date,
          max(dw.view_count) FILTER (WHERE dw.date_role = 'today') AS current_view,
          max(dw.view_count) FILTER (WHERE dw.date_role = 'yesterday') AS previous_view,
          max(dw.view_count) FILTER (WHERE dw.date_role = 'seven_days_ago') AS seven_day_view
        FROM daily_window dw
        CROSS JOIN target_dates td
        GROUP BY dw.aid, td.today
        HAVING max(dw.view_count) FILTER (WHERE dw.date_role = 'today') IS NOT NULL
      ),
      calculated AS (
        SELECT
          m.aid,
          CASE
            WHEN m.previous_view IS NULL THEN NULL
            ELSE greatest(m.current_view - m.previous_view, 0)
          END AS latest_daily_delta,
          CASE
            WHEN m.seven_day_view IS NULL THEN NULL
            ELSE greatest(m.current_view - m.seven_day_view, 0)::numeric / 7.0
          END AS weekly_avg_daily_delta,
          CASE
            WHEN m.previous_view IS NOT NULL THEN 'daily_delta'
            WHEN m.seven_day_view IS NOT NULL THEN 'weekly_avg'
            ELSE 'processed_backfill'
          END AS daily_delta_source,
          CASE
            WHEN m.seven_day_view IS NOT NULL AND m.current_view = m.seven_day_view THEN -2
            WHEN COALESCE(greatest(m.current_view - m.previous_view, 0), 0) > 100 THEN
              fn_video_collection_priority(
                greatest(m.current_view - m.previous_view, 0),
                p_target_delta_per_sample,
                p_target_delta_lower,
                p_target_delta_upper,
                p_min_positive_priority,
                p_max_positive_priority
              )
            WHEN COALESCE(greatest(m.current_view - m.seven_day_view, 0)::numeric / 7.0, 0) >= 100 THEN
              fn_video_collection_priority(
                greatest(m.current_view - m.seven_day_view, 0)::numeric / 7.0,
                p_target_delta_per_sample,
                p_target_delta_lower,
                p_target_delta_upper,
                p_min_positive_priority,
                p_max_positive_priority
              )
            WHEN m.seven_day_view IS NOT NULL AND m.current_view > m.seven_day_view THEN 0
            ELSE 0
          END AS priority,
          m.record_date AS last_daily_record_date,
          m.current_view AS last_view
        FROM measured m
      ),
      upserted AS (
        INSERT INTO video_collection_state (
          aid,
          latest_daily_delta,
          weekly_avg_daily_delta,
          daily_delta_source,
          priority,
          next_minute_due_at,
          last_daily_record_date,
          last_view,
          updated_at
        )
        SELECT
          c.aid,
          c.latest_daily_delta,
          c.weekly_avg_daily_delta,
          c.daily_delta_source,
          c.priority,
          CASE
            WHEN c.priority > 0 THEN fn_video_collection_next_due_at(c.aid, c.priority, p_now)
            ELSE NULL
          END,
          c.last_daily_record_date,
          c.last_view,
          p_now
        FROM calculated c
        ON CONFLICT (aid) DO UPDATE SET
          latest_daily_delta = EXCLUDED.latest_daily_delta,
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
             AND (
               video_collection_state.next_minute_due_at IS NULL
               OR video_collection_state.priority IS DISTINCT FROM EXCLUDED.priority
             )
            THEN fn_video_collection_next_due_at(EXCLUDED.aid, EXCLUDED.priority, p_now)
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
          last_view = EXCLUDED.last_view,
          updated_at = p_now
        RETURNING 1
      )
      SELECT count(*) INTO changed_count FROM upserted;

      RETURN changed_count;
    END;
    $$ LANGUAGE plpgsql
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
        UPDATE video_collection_state
        SET priority = -1,
            next_minute_due_at = NULL,
            updated_at = p_now
        WHERE aid = p_aid;
        RETURN CASE WHEN found THEN 'disabled_deleted' ELSE 'ignored_deleted' END;
      END IF;

      IF has_existing AND existing_priority = -1 THEN
        RETURN 'ignored_existing_disabled';
      END IF;

      IF p_is_filtered IS FALSE THEN
        UPDATE video_collection_state
        SET priority = -1,
            next_minute_due_at = NULL,
            updated_at = p_now
        WHERE aid = p_aid;
        RETURN CASE WHEN found THEN 'disabled_filtered_out' ELSE 'ignored_filtered_out' END;
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
        UPDATE video_collection_state
        SET priority = -1,
            next_minute_due_at = NULL,
            updated_at = p_now
        WHERE aid = p_aid;
        RETURN CASE WHEN found THEN 'disabled_label_demotion' ELSE 'ignored_label_demotion' END;
      END IF;

      IF NOT should_track THEN
        RETURN 'ignored_label_not_ready';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM video_daily WHERE aid = p_aid LIMIT 1
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
      previous_rows AS (
        SELECT
          l.aid,
          prev."view"::bigint AS previous_view
        FROM latest_rows l
        LEFT JOIN LATERAL (
          SELECT vm."view"
          FROM video_minute vm
          WHERE vm.aid = l.aid
            AND vm."time" < l."time"
          ORDER BY vm."time" DESC
          LIMIT 1
        ) prev ON true
      ),
      computed AS (
        SELECT
          s.aid,
          l."time",
          l.latest_view,
          CASE
            WHEN s.priority = -1 THEN -1
            WHEN p.previous_view IS NOT NULL
             AND l.latest_view - p.previous_view >= ${config.minute.minuteBurstDeltaThreshold}
            THEN CASE
              WHEN s.priority > 0 THEN least(s.priority, ${config.minute.minuteBurstPriority})
              ELSE ${config.minute.minuteBurstPriority}
            END
            ELSE s.priority
          END AS next_priority
        FROM video_collection_state s
        JOIN latest_rows l ON l.aid = s.aid
        LEFT JOIN previous_rows p ON p.aid = l.aid
      )
      UPDATE video_collection_state s
      SET last_minute_success_at = c."time",
          last_view = c.latest_view,
          priority = c.next_priority,
          next_minute_due_at = CASE
            WHEN c.next_priority > 0 THEN c."time" + make_interval(mins => c.next_priority)
            ELSE NULL
          END,
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
