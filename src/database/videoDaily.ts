import type { Pool } from "pg";
import type { DailyCollectionCandidate } from "../types/models/minute.js";

function mapCandidate(row: Record<string, unknown>): DailyCollectionCandidate {
  return {
    aid: BigInt(row.aid as string | number),
    latestDailyDelta:
      row.latest_daily_delta === null || row.latest_daily_delta === undefined
        ? null
        : Number(row.latest_daily_delta),
    weeklyAvgDailyDelta:
      row.weekly_avg_daily_delta === null ||
      row.weekly_avg_daily_delta === undefined
        ? null
        : Number(row.weekly_avg_daily_delta),
    priority: Number(row.priority),
    lastDailyRecordDate: (row.last_daily_record_date as Date | null) ?? null,
    lastView:
      row.last_view === null || row.last_view === undefined
        ? null
        : Number(row.last_view),
  };
}

export async function getDailyCollectionCandidates(
  pool: Pool,
  options?: {
    includeWeeklyOnly?: boolean;
    now?: Date;
    businessTimezone?: string;
    limit?: number;
  },
): Promise<DailyCollectionCandidate[]> {
  const result = await pool.query(
    `
    WITH business_day AS (
      SELECT ($1::timestamptz AT TIME ZONE $2)::date AS today
    ),
    latest AS (
      SELECT DISTINCT ON (vd.aid)
        vd.aid,
        vd.record_date,
        vd."view"::bigint AS current_view
      FROM video_daily vd
      JOIN business_day bd ON vd.record_date < bd.today
      ORDER BY vd.aid, vd.record_date DESC
    ),
    measured AS (
      SELECT
        l.aid,
        l.record_date,
        l.current_view,
        prev."view"::bigint AS previous_view,
        seven."view"::bigint AS seven_day_view
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT vd."view"
        FROM video_daily vd
        WHERE vd.aid = l.aid
          AND vd.record_date < l.record_date
        ORDER BY vd.record_date DESC
        LIMIT 1
      ) prev ON true
      LEFT JOIN LATERAL (
        SELECT vd."view"
        FROM video_daily vd
        WHERE vd.aid = l.aid
          AND vd.record_date = l.record_date - 7
        LIMIT 1
      ) seven ON true
    )
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
        WHEN COALESCE(greatest(m.current_view - m.previous_view, 0), 0) > 100
          OR (
            $3::boolean
            AND COALESCE(greatest(m.current_view - m.seven_day_view, 0)::numeric / 7.0, 0) >= 100
          )
        THEN 1
        ELSE 0
      END AS priority,
      m.record_date AS last_daily_record_date,
      m.current_view AS last_view
    FROM measured m
    WHERE COALESCE(greatest(m.current_view - m.previous_view, 0), 0) > 100
       OR (
         $3::boolean
         AND COALESCE(greatest(m.current_view - m.seven_day_view, 0)::numeric / 7.0, 0) >= 100
       )
    ORDER BY m.aid
    LIMIT $4::int
  `,
    [
      options?.now ?? new Date(),
      options?.businessTimezone ?? "Asia/Shanghai",
      options?.includeWeeklyOnly ?? true,
      options?.limit ?? null,
    ],
  );
  return result.rows.map(mapCandidate);
}
