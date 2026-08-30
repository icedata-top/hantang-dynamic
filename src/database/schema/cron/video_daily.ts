import type { Pool } from "pg";
import { config } from "../../../config/index.js";
import { logger } from "../../../utils/logger.js";

const VIDEO_DAILY_SYNC_BATCH_SIZE = 5_000;

// every day at UTC 21:30 (Beijing 05:30)
export async function initCronVideoDaily(
  pool: Pool,
  schema: string,
): Promise<void> {
  const businessTimezone = config.minute.collectionBusinessTimezone.replace(
    /'/g,
    "''",
  );

  await pool.query(`
    CREATE OR REPLACE PROCEDURE "${schema}".sync_video_daily_from_mysql(
      p_start_date date,
      p_end_date date,
      p_batch_size integer DEFAULT ${VIDEO_DAILY_SYNC_BATCH_SIZE}
    )
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_record_date date;
      v_last_aid bigint;
      v_batch_rows integer;
    BEGIN
      IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'video_daily sync requires fixed start and end dates';
      END IF;
      IF p_start_date > p_end_date THEN
        RAISE EXCEPTION 'video_daily sync start date must not be after end date';
      END IF;
      IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 50000 THEN
        RAISE EXCEPTION 'video_daily sync batch size must be between 1 and 50000';
      END IF;

      CREATE TEMP TABLE IF NOT EXISTS video_daily_sync_batch (
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

      v_record_date := p_start_date;
      WHILE v_record_date <= p_end_date LOOP
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
          FROM "${schema}".mysql_video_daily AS source
          WHERE source.record_date = v_record_date
            AND (v_last_aid IS NULL OR source.aid > v_last_aid)
          ORDER BY source.aid
          LIMIT p_batch_size;

          GET DIAGNOSTICS v_batch_rows = ROW_COUNT;
          EXIT WHEN v_batch_rows = 0;

          SELECT max(aid) INTO v_last_aid
          FROM pg_temp.video_daily_sync_batch;

          -- Both cron and maintenance calls use this transaction-scoped lock.
          -- COMMIT releases it, so each bounded batch acquires it independently.
          PERFORM pg_advisory_xact_lock(
            hashtextextended('${schema}.video_daily_mysql_sync', 0)
          );

          UPDATE "${schema}".video_daily AS target
          SET
            coin = source.coin,
            favorite = source.favorite,
            danmaku = source.danmaku,
            "view" = source."view",
            reply = source.reply,
            share = source.share,
            "like" = source."like"
          FROM pg_temp.video_daily_sync_batch AS source
          WHERE target.aid = source.aid
            AND target.record_date = source.record_date
            AND ROW(
              target.coin, target.favorite, target.danmaku, target."view",
              target.reply, target.share, target."like"
            ) IS DISTINCT FROM ROW(
              source.coin, source.favorite, source.danmaku, source."view",
              source.reply, source.share, source."like"
            );

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
          WHERE NOT EXISTS (
            SELECT 1
            FROM "${schema}".video_daily AS target
            WHERE target.aid = source.aid
              AND target.record_date = source.record_date
          )
          ORDER BY source.aid;

          COMMIT;
        END LOOP;

        v_record_date := v_record_date + 1;
      END LOOP;
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
          ${VIDEO_DAILY_SYNC_BATCH_SIZE}
        )
        $$
      )
    `);
    logger.info("pg_cron: sync_video_daily_from_mysql scheduled");
  } catch (err) {
    logger.debug("pg_cron: sync_video_daily_from_mysql skipped", { err });
  }
}
