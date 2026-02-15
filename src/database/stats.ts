import type { Pool } from "pg";
import type { DatabaseStats } from "../types/models/database.js";

/**
 * Get database statistics
 */
export async function getStats(pool: Pool): Promise<DatabaseStats> {
  const result = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM processed_videos) as processed_count,
      (SELECT COUNT(*) FROM dynamics) as dynamics_count,
      (SELECT COUNT(*) FROM recommendations) as rec_count,
      (SELECT COUNT(*) FROM discovered_users) as users_count,
      (SELECT COUNT(*) FROM processed_videos WHERE is_filtered = true) as filtered_count
  `);

  const row = result.rows[0];

  return {
    processedVideosCount: Number.parseInt(row.processed_count, 10),
    dynamicsCount: Number.parseInt(row.dynamics_count, 10),
    recommendationsCount: Number.parseInt(row.rec_count, 10),
    discoveredUsersCount: Number.parseInt(row.users_count, 10),
    filteredVideosCount: Number.parseInt(row.filtered_count, 10),
  };
}
