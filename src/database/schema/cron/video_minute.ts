import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

export async function initCronVideoMinute(
  pool: Pool,
  schema: string,
): Promise<void> {
  await pool.query(`DROP FUNCTION IF EXISTS ${schema}.sync_video_minute();`);

  await pool.query(`
    CREATE OR REPLACE FUNCTION ${schema}.sync_video_minute()
    RETURNS SETOF boolean
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      v_cutoff   bigint;
      v_inserted bigint;
    BEGIN
      SELECT coalesce(
        extract(epoch from max("time"))::bigint,
        extract(epoch from now() - INTERVAL '2 hours')::bigint
      )
      INTO v_cutoff
      FROM ${schema}.video_minute;

      EXECUTE format(
        'INSERT INTO ${schema}.video_minute
           ("time", aid, coin, favorite, danmaku, "view", reply, share, "like")
         SELECT
           to_timestamp("time"), aid, coin, favorite, danmaku,
           "view", reply, share, "like"
         FROM ${schema}.mysql_video_minute m
         WHERE m.\"time\" > %s',
        v_cutoff
      );

      GET DIAGNOSTICS v_inserted = ROW_COUNT;

      FOR i IN 1..v_inserted LOOP
        RETURN NEXT true;
      END LOOP;

      RETURN;
    END;
    $fn$;
  `);

  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      ["sync_video_minute_from_mysql"],
    );
  } catch {
    // ignore
  }

  try {
    await pool.query(
      `SELECT cron.schedule($1, $2, $3)`,
      [
        "sync_video_minute_from_mysql",
        "*/3 * * * *",
        `SELECT ${schema}.sync_video_minute()`,
      ],
    );
    logger.info("pg_cron: sync_video_minute scheduled (*/3 min)");
  } catch (err) {
    logger.debug("pg_cron: sync_video_minute skipped", { err });
  }
}
