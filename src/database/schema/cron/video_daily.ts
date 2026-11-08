import type { Pool } from "pg";
import { config } from "../../../config/index.js";
import { logger } from "../../../utils/logger.js";
import { VIDEO_DAILY_SYNC_BATCH_SIZE } from "../../videoDaily.js";

// every day at UTC 21:30 (Beijing 05:30)
// Insert-only: copies keys missing from video_daily and never updates existing
// rows, matching the manual --backfill-video-daily worker. With
// database.prune_video_daily_source the whole source is copied and then
// truncated once its row count is unchanged since the pre-copy snapshot.
export async function initCronVideoDaily(
  pool: Pool,
  schema: string,
): Promise<void> {
  const businessTimezone = config.minute.collectionBusinessTimezone.replace(
    /'/g,
    "''",
  );

  // CREATE OR REPLACE cannot change the argument list: drop the old signature
  // so a three-argument CALL stays unambiguous.
  const prune = config.database.pruneVideoDailySource ? "true" : "false";
  await pool.query(
    `DROP PROCEDURE IF EXISTS "${schema}".sync_video_daily_from_mysql(date, date, integer)`,
  );
  await pool.query(`
    CREATE OR REPLACE PROCEDURE "${schema}".sync_video_daily_from_mysql(
      p_start_date date,
      p_end_date date,
      p_batch_size integer DEFAULT NULL,
      p_prune boolean DEFAULT false
    )
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_record_date date;
      v_sync_start date;
      v_sync_end date;
      v_last_aid bigint;
      v_batch_first_aid bigint;
      v_batch_rows integer;
      v_staged_rows integer;
      v_inserted_rows integer;
      v_target_rows bigint;
      v_pass integer := 0;
      v_prune boolean := coalesce(p_prune, false);
      v_snapshot_rows bigint;
      v_dated_rows bigint;
      v_final_rows bigint;
      v_min_date date;
      v_max_date date;
    BEGIN
      IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'video_daily sync requires fixed start and end dates';
      END IF;
      IF p_start_date > p_end_date THEN
        RAISE EXCEPTION 'video_daily sync start date must not be after end date';
      END IF;
      IF p_batch_size IS NOT NULL AND p_batch_size < 1 THEN
        RAISE EXCEPTION 'video_daily sync batch size must be positive';
      END IF;

      PERFORM pg_advisory_lock(
        hashtextextended('${schema}.video_daily_mysql_sync', 0)
      );

      CREATE TEMP TABLE IF NOT EXISTS video_daily_sync_day (
        record_date date NOT NULL,
        aid bigint PRIMARY KEY,
        coin integer,
        favorite integer,
        danmaku integer,
        "view" integer,
        reply integer,
        share integer,
        "like" integer
      ) ON COMMIT PRESERVE ROWS;

      CREATE TEMP TABLE IF NOT EXISTS video_daily_sync_batch
        (LIKE pg_temp.video_daily_sync_day INCLUDING ALL)
        ON COMMIT PRESERVE ROWS;

      LOOP
        v_pass := v_pass + 1;
        v_sync_start := p_start_date;
        v_sync_end := p_end_date;

        IF v_prune THEN
          -- Prune mode copies the whole source table: the source is append-only
          -- and only this procedure and the manual worker delete from it, so an
          -- unchanged row count proves nothing was added since the snapshot.
          SELECT min(source.record_date), max(source.record_date),
                 count(source.record_date), count(*)
          INTO v_min_date, v_max_date, v_dated_rows, v_snapshot_rows
          FROM "${schema}".mysql_video_daily AS source;

          IF v_snapshot_rows = 0 THEN
            RAISE NOTICE 'video_daily sync: source is empty, nothing to prune';
            EXIT;
          END IF;
          IF v_dated_rows <> v_snapshot_rows THEN
            -- Rows without a date can never be copied, so keep the source and
            -- fall back to the regular recent-dates sync.
            RAISE WARNING 'video_daily sync: % source rows have no record_date, pruning disabled for this run',
              v_snapshot_rows - v_dated_rows;
            v_prune := false;
            CONTINUE;
          END IF;
          v_sync_start := v_min_date;
          v_sync_end := v_max_date;
          RAISE NOTICE 'video_daily sync: prune pass %, source rows %, dates % to %',
            v_pass, v_snapshot_rows, v_sync_start, v_sync_end;
        END IF;

        v_record_date := v_sync_start;
        WHILE v_record_date <= v_sync_end LOOP
          TRUNCATE pg_temp.video_daily_sync_day;

          INSERT INTO pg_temp.video_daily_sync_day (
            record_date, aid, coin, favorite, danmaku, "view", reply, share, "like"
          )
          SELECT DISTINCT ON (source.aid)
            source.record_date,
            source.aid,
            source.coin,
            source.favorite,
            source.danmaku,
            source."view",
            source.reply,
            source.share,
            source."like"
          FROM "${schema}".mysql_video_daily AS source
          WHERE source.record_date = v_record_date
          ORDER BY
            source.aid,
            source."view" ASC NULLS LAST,
            source.coin ASC NULLS LAST,
            source.favorite ASC NULLS LAST,
            source.danmaku ASC NULLS LAST,
            source.reply ASC NULLS LAST,
            source.share ASC NULLS LAST,
            source."like" ASC NULLS LAST;

          GET DIAGNOSTICS v_staged_rows = ROW_COUNT;
          ANALYZE pg_temp.video_daily_sync_day;
          RAISE NOTICE 'video_daily sync: staged date %, rows %',
            v_record_date, v_staged_rows;

          v_last_aid := NULL;

          LOOP
            TRUNCATE pg_temp.video_daily_sync_batch;

            INSERT INTO pg_temp.video_daily_sync_batch (
              record_date, aid, coin, favorite, danmaku, "view", reply, share, "like"
            )
            SELECT
              source.record_date,
              source.aid,
              source.coin,
              source.favorite,
              source.danmaku,
              source."view",
              source.reply,
              source.share,
              source."like"
            FROM pg_temp.video_daily_sync_day AS source
            WHERE source.record_date = v_record_date
              AND (v_last_aid IS NULL OR source.aid > v_last_aid)
            ORDER BY source.aid
            LIMIT p_batch_size;

            GET DIAGNOSTICS v_batch_rows = ROW_COUNT;
            EXIT WHEN v_batch_rows = 0;

            SELECT min(aid), max(aid)
            INTO v_batch_first_aid, v_last_aid
            FROM pg_temp.video_daily_sync_batch;

            -- Source history is append-only, so existing keys are never
            -- rewritten. Plan each date separately so TimescaleDB prunes
            -- historical chunks before applying the hypertable INSERT.
            EXECUTE $sync_insert$
              INSERT INTO "${schema}".video_daily (
                record_date, aid, coin, favorite, danmaku, "view", reply, share, "like"
              )
              SELECT
                source.record_date,
                source.aid,
                source.coin,
                source.favorite,
                source.danmaku,
                source."view",
                source.reply,
                source.share,
                source."like"
              FROM pg_temp.video_daily_sync_batch AS source
              WHERE source.record_date = $1
                AND NOT EXISTS (
                  SELECT 1
                  FROM "${schema}".video_daily AS target
                  WHERE target.record_date = $1
                    AND target.aid = source.aid
                    AND target.record_date = source.record_date
                )
              ORDER BY source.aid
            $sync_insert$ USING v_record_date;

            GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;

            COMMIT;
            RAISE NOTICE 'video_daily sync: completed date %, aids %..%, batch rows %, inserted %',
              v_record_date, v_batch_first_aid, v_last_aid, v_batch_rows,
              v_inserted_rows;
          END LOOP;

          IF v_prune AND v_staged_rows > 0 THEN
            -- Every staged key was inserted or already present, so the target
            -- holds at least as many rows for the date as the source did.
            SELECT count(*) INTO v_target_rows
            FROM "${schema}".video_daily AS target
            WHERE target.record_date = v_record_date;
            IF v_target_rows < v_staged_rows THEN
              RAISE EXCEPTION 'video_daily sync: date % has % target rows for % source rows, refusing to prune',
                v_record_date, v_target_rows, v_staged_rows;
            END IF;
          END IF;

          v_record_date := v_record_date + 1;
        END LOOP;

        EXIT WHEN NOT v_prune;

        SELECT count(*) INTO v_final_rows
        FROM "${schema}".mysql_video_daily;

        IF v_final_rows = v_snapshot_rows THEN
          TRUNCATE "${schema}".mysql_video_daily;
          COMMIT;
          RAISE NOTICE 'video_daily sync: pruned % source rows after verified copy',
            v_snapshot_rows;
          EXIT;
        END IF;

        RAISE NOTICE 'video_daily sync: source grew from % to % rows during pass %',
          v_snapshot_rows, v_final_rows, v_pass;
        IF v_pass >= 3 THEN
          RAISE NOTICE 'video_daily sync: source kept; it changed during every pass, will retry next run';
          EXIT;
        END IF;
      END LOOP;

      PERFORM pg_advisory_unlock(
        hashtextextended('${schema}.video_daily_mysql_sync', 0)
      );
    END;
    $$
  `);

  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_daily_from_mysql"],
    );
  } catch {
    // ignore: job didn't exist yet or pg_cron not available
  }
  try {
    await pool.query(`
      SELECT cron.schedule(
        'sync_video_daily_from_mysql',
        '30 21 * * *',
        $$
        CALL "${schema}".sync_video_daily_from_mysql(
          (CURRENT_TIMESTAMP AT TIME ZONE '${businessTimezone}')::date - 2,
          (CURRENT_TIMESTAMP AT TIME ZONE '${businessTimezone}')::date,
          ${VIDEO_DAILY_SYNC_BATCH_SIZE},
          ${prune}
        )
        $$
      )
    `);
    logger.info("pg_cron: sync_video_daily_from_mysql scheduled");
  } catch (err) {
    logger.debug("pg_cron: sync_video_daily_from_mysql skipped", { err });
  }
}
