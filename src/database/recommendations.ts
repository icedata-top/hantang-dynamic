import type { Pool } from "pg";
import type { RecommendationData } from "../types/models/database.js";

export interface RecommendationInput {
  videoAid: bigint | number;
  recommendedByAid: bigint | number;
  order: number;
}

/**
 * Batch track recommendation relationships using UPSERT.
 * Uses INSERT ... ON CONFLICT to avoid separate SELECT + UPDATE.
 */
export async function trackRecommendationsBatch(
  pool: Pool,
  recommendations: RecommendationInput[],
): Promise<void> {
  if (recommendations.length === 0) return;

  const placeholders: string[] = [];
  const params: (string | number)[] = [];
  let paramIndex = 1;

  for (const rec of recommendations) {
    placeholders.push(
      `($${paramIndex}, $${paramIndex + 1}, 1, $${paramIndex + 2})`,
    );
    params.push(BigInt(rec.videoAid).toString());
    params.push(BigInt(rec.recommendedByAid).toString());
    params.push(rec.order);
    paramIndex += 3;
  }

  const sql = `
    INSERT INTO recommendations
      (video_aid, recommended_by_aid, recommend_count, recommend_order)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (video_aid, recommended_by_aid)
    DO UPDATE SET
      recommend_count = recommendations.recommend_count + 1,
      recommend_order = EXCLUDED.recommend_order,
      last_seen = NOW()
  `;

  await pool.query(sql, params);
}

/**
 * Get top recommended videos
 */
export async function getTopRecommendedVideos(
  pool: Pool,
  limit: number,
): Promise<RecommendationData[]> {
  const result = await pool.query(
    `SELECT * FROM recommendations
     ORDER BY recommend_count DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    videoAid: BigInt(row.video_aid),
    recommendedByAid: BigInt(row.recommended_by_aid),
    recommendCount: row.recommend_count as number,
    recommendOrder: row.recommend_order as number,
    firstSeen: new Date(row.first_seen),
    lastSeen: new Date(row.last_seen),
  }));
}
