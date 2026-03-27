import type { Pool } from "pg";
import { logger } from "../../../utils/logger.js";

export async function initCronVideoMinute(
  pool: Pool,
  schema: string,
): Promise<void> {
  const jobName = "sync_video_minute_from_mysql";

  try {
    await pool.query(
      `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`,
      [jobName],
    );
  } catch {
    // ignore
  }

  const cronSql = `
    DO $BODY$
    DECLARE
      v_cutoff   bigint;
      v_inserted bigint;
    BEGIN
      SELECT coalesce(
        extract(epoch from max("time"))::bigint,
        extract(epoch from now() - INTERVAL '2 hours')::bigint
      )
      INTO v_cutoff
      FROM "${schema}".video_minute;

      EXECUTE format(
        'INSERT INTO "${schema}".video_minute
           ("time", aid, coin, favorite, danmaku, "view", reply, share, "like")
         SELECT
           to_timestamp("time"), aid, coin, favorite, danmaku,
           "view", reply, share, "like"
         FROM "${schema}".mysql_video_minute m
         WHERE m."time" > %s',
        v_cutoff
      );

      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      RAISE LOG 'video_minute sync done | cutoff=% inserted=%',
        to_timestamp(v_cutoff), v_inserted;
    END
    $BODY$;
  `;

  try {
    await pool.query(`SELECT cron.schedule($1, $2, $3)`, [
      jobName,
      "15 * * * *",
      cronSql,
    ]);
    logger.info(`pg_cron: ${jobName} scheduled`);
  } catch (err) {
    logger.debug(`pg_cron: ${jobName} skipped`, { err });
  }
}
