import type { Pool } from "pg";
import type {
  DiscoveredUserData,
  UserData,
  UserStatsUpdate,
} from "../types/models/database.js";

/**
 * Check if a user exists in the database
 */
export async function hasUser(pool: Pool, userId: bigint): Promise<boolean> {
  const result = await pool.query(
    "SELECT COUNT(*) as count FROM discovered_users WHERE user_id = $1",
    [userId.toString()],
  );

  return Number.parseInt(result.rows[0]?.count || "0", 10) > 0;
}

/**
 * Add a discovered user
 */
export async function addDiscoveredUser(
  pool: Pool,
  user: DiscoveredUserData,
): Promise<void> {
  await pool.query(
    `INSERT INTO discovered_users 
     (user_id, user_name, fans, discovered_from, videos_seen, videos_filtered, filter_pass_rate)
     VALUES ($1, $2, $3, $4, 0, 0, 0.0)
     ON CONFLICT (user_id) DO UPDATE SET
       user_name = EXCLUDED.user_name,
       fans = EXCLUDED.fans`,
    [user.userId.toString(), user.userName, user.fans, user.source],
  );
}

/**
 * Update user statistics
 */
export async function updateUserStats(
  pool: Pool,
  userId: bigint,
  stats: UserStatsUpdate,
): Promise<void> {
  // Build update query dynamically
  const updates: string[] = [];
  const params: (string | number)[] = [];
  let paramIndex = 1;

  if (stats.videosSeen !== undefined) {
    updates.push(`videos_seen = videos_seen + $${paramIndex}`);
    params.push(stats.videosSeen);
    paramIndex++;
  }

  if (stats.videosFiltered !== undefined) {
    updates.push(`videos_filtered = videos_filtered + $${paramIndex}`);
    params.push(stats.videosFiltered);
    paramIndex++;
  }

  if (stats.fans !== undefined) {
    updates.push(`fans = $${paramIndex}`);
    params.push(stats.fans);
    paramIndex++;
  }

  if (stats.userName !== undefined) {
    updates.push(`user_name = $${paramIndex}`);
    params.push(stats.userName);
    paramIndex++;
  }

  // Calculate filter pass rate - this is computed in the query itself
  updates.push(
    "filter_pass_rate = CASE WHEN videos_seen > 0 THEN CAST(videos_filtered AS REAL) / videos_seen ELSE 0.0 END",
  );
  updates.push("last_updated = NOW()");

  // Add user_id as last parameter
  params.push(userId.toString());

  if (updates.length > 0) {
    await pool.query(
      `UPDATE discovered_users SET ${updates.join(
        ", ",
      )} WHERE user_id = $${paramIndex}`,
      params,
    );
  }
}

/**
 * Get top discovered users
 */
export async function getTopDiscoveredUsers(
  pool: Pool,
  orderBy: "filter_pass_rate" | "fans",
  limit: number,
): Promise<UserData[]> {
  const result = await pool.query(
    `SELECT * FROM discovered_users 
     ORDER BY ${orderBy} DESC 
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    userId: BigInt(row.user_id),
    userName: row.user_name as string,
    fans: row.fans as number,
    videosSeen: row.videos_seen as number,
    videosFiltered: row.videos_filtered as number,
    filterPassRate: row.filter_pass_rate as number,
    discoveredFrom: row.discovered_from as "following" | "recommendation",
    discoveredAt: new Date(row.discovered_at),
    isFollowing: row.is_following as boolean,
    lastUpdated: new Date(row.last_updated),
  }));
}
