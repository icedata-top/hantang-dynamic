import type { DuckDBConnection } from "@duckdb/node-api";
import type { DatabaseStats } from "../types/models/database.js";

/**
 * Get database statistics
 */
export async function getStats(
  connection: DuckDBConnection,
): Promise<DatabaseStats> {
  const reader = await connection.runAndReadAll(`
    SELECT 
      (SELECT COUNT(*) FROM processed_videos) as processed_count,
      (SELECT COUNT(*) FROM forward_dynamics) as forward_count,
      (SELECT COUNT(*) FROM recommendations) as rec_count,
      (SELECT COUNT(*) FROM discovered_users) as users_count,
      (SELECT COUNT(*) FROM processed_videos WHERE is_filtered = true) as filtered_count
  `);

  const rows = reader.getRows();
  const row = rows[0];

  return {
    processedVideosCount: row[0] as number,
    forwardDynamicsCount: row[1] as number,
    recommendationsCount: row[2] as number,
    discoveredUsersCount: row[3] as number,
    filteredVideosCount: row[4] as number,
  };
}
