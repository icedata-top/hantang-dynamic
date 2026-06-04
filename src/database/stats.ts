import type { Pool } from "pg";
import type { DatabaseStats } from "../types/models/database.js";

/**
 * Get database statistics using pg_stat estimates (O(1) instead of 5 full scans).
 * Values are approximate — updated by autovacuum, typically within a few percent.
 * The filtered count uses an index-only scan for exactness.
 */
export async function getStats(pool: Pool): Promise<DatabaseStats> {
  const result = await pool.query(`
    SELECT
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'processed_videos')  AS processed_count,
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'dynamics')           AS dynamics_count,
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'recommendations')    AS rec_count,
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'discovered_users')   AS users_count,
      (SELECT COUNT(*) FROM processed_videos WHERE is_filtered = true)                  AS filtered_count
  `);

  const row = result.rows[0];

  return {
    processedVideosCount: Number(row.processed_count ?? 0),
    dynamicsCount: Number(row.dynamics_count ?? 0),
    recommendationsCount: Number(row.rec_count ?? 0),
    discoveredUsersCount: Number(row.users_count ?? 0),
    filteredVideosCount: Number(row.filtered_count ?? 0),
  };
}
