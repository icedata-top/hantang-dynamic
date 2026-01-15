import type { DuckDBConnection } from "@duckdb/node-api";
import type { RecommendationData } from "../types/models/database.js";

/**
 * Track recommendation relationship
 */
export async function trackRecommendation(
  connection: DuckDBConnection,
  videoBvid: string,
  recommendedByBvid: string,
  order: number,
): Promise<void> {
  // Check if recommendation already exists
  const reader = await connection.runAndReadAll(
    `SELECT recommend_count FROM recommendations 
     WHERE video_bvid = $1 AND recommended_by_bvid = $2`,
    { 1: videoBvid, 2: recommendedByBvid },
  );

  const rows = reader.getRows();

  if (rows.length > 0) {
    // Update existing recommendation
    const currentCount = rows[0]?.[0] as number;
    await connection.run(
      `UPDATE recommendations 
       SET recommend_count = $1, last_seen = CURRENT_TIMESTAMP, recommend_order = $2
       WHERE video_bvid = $3 AND recommended_by_bvid = $4`,
      {
        1: currentCount + 1,
        2: order,
        3: videoBvid,
        4: recommendedByBvid,
      },
    );
  } else {
    // Insert new recommendation
    await connection.run(
      `INSERT INTO recommendations 
       (video_bvid, recommended_by_bvid, recommend_count, recommend_order)
       VALUES ($1, $2, $3, $4)`,
      {
        1: videoBvid,
        2: recommendedByBvid,
        3: 1,
        4: order,
      },
    );
  }
}

/**
 * Get top recommended videos
 */
export async function getTopRecommendedVideos(
  connection: DuckDBConnection,
  limit: number,
): Promise<RecommendationData[]> {
  const reader = await connection.runAndReadAll(
    `SELECT * FROM recommendations 
     ORDER BY recommend_count DESC 
     LIMIT $1`,
    { 1: limit },
  );

  const rows = reader.getRowObjects();

  return rows.map((row) => ({
    videoBvid: row.video_bvid as string,
    recommendedByBvid: row.recommended_by_bvid as string,
    recommendCount: row.recommend_count as number,
    recommendOrder: row.recommend_order as number,
    firstSeen: new Date(row.first_seen as string),
    lastSeen: new Date(row.last_seen as string),
  }));
}
