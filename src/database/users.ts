import type { DuckDBConnection } from "@duckdb/node-api";
import type {
  DiscoveredUserData,
  UserData,
  UserStatsUpdate,
} from "../types/models/database.js";

/**
 * Check if a user exists in the database
 */
export async function hasUser(
  connection: DuckDBConnection,
  userId: bigint,
): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    "SELECT COUNT(*) as count FROM discovered_users WHERE user_id = $1",
    { 1: userId },
  );

  const rows = reader.getRows();
  return (rows[0]?.[0] as number) > 0;
}

/**
 * Add a discovered user
 */
export async function addDiscoveredUser(
  connection: DuckDBConnection,
  user: DiscoveredUserData,
): Promise<void> {
  await connection.run(
    `INSERT INTO discovered_users 
     (user_id, user_name, fans, discovered_from, videos_seen, videos_filtered, filter_pass_rate)
     VALUES ($1, $2, $3, $4, 0, 0, 0.0)
     ON CONFLICT (user_id) DO UPDATE SET
       user_name = EXCLUDED.user_name,
       fans = EXCLUDED.fans`,
    {
      1: user.userId,
      2: user.userName,
      3: user.fans,
      4: user.source,
    },
  );
}

/**
 * Update user statistics
 */
export async function updateUserStats(
  connection: DuckDBConnection,
  userId: bigint,
  stats: UserStatsUpdate,
): Promise<void> {
  // Build update query dynamically
  const updates: string[] = [];
  const params: Record<string, bigint | number | string> = { userId };

  if (stats.videosSeen !== undefined) {
    updates.push("videos_seen = videos_seen + $videosSeen");
    params.videosSeen = stats.videosSeen;
  }

  if (stats.videosFiltered !== undefined) {
    updates.push("videos_filtered = videos_filtered + $videosFiltered");
    params.videosFiltered = stats.videosFiltered;
  }

  if (stats.fans !== undefined) {
    updates.push("fans = $fans");
    params.fans = stats.fans;
  }

  if (stats.userName !== undefined) {
    updates.push("user_name = $userName");
    params.userName = stats.userName;
  }

  // Calculate filter pass rate based on updated values
  let filterPassRateCalc = "filter_pass_rate";
  if (stats.videosSeen !== undefined || stats.videosFiltered !== undefined) {
    filterPassRateCalc =
      "CASE WHEN (videos_seen" +
      (stats.videosSeen !== undefined ? " + $videosSeen" : "") +
      ") > 0 THEN CAST((videos_filtered" +
      (stats.videosFiltered !== undefined ? " + $videosFiltered" : "") +
      ") AS REAL) / (videos_seen" +
      (stats.videosSeen !== undefined ? " + $videosSeen" : "") +
      ") ELSE 0.0 END";
  }
  updates.push(`filter_pass_rate = ${filterPassRateCalc}`);
  updates.push("last_updated = NOW()");

  if (updates.length > 0) {
    await connection.run(
      `UPDATE discovered_users SET ${updates.join(
        ", ",
      )} WHERE user_id = $userId`,
      params,
    );
  }
}

/**
 * Get top discovered users
 */
export async function getTopDiscoveredUsers(
  connection: DuckDBConnection,
  orderBy: "filter_pass_rate" | "fans",
  limit: number,
): Promise<UserData[]> {
  const reader = await connection.runAndReadAll(
    `SELECT * FROM discovered_users 
     ORDER BY ${orderBy} DESC 
     LIMIT $1`,
    { 1: limit },
  );

  const rows = reader.getRowObjects();

  return rows.map((row) => ({
    userId: row.user_id as bigint,
    userName: row.user_name as string,
    fans: row.fans as number,
    videosSeen: row.videos_seen as number,
    videosFiltered: row.videos_filtered as number,
    filterPassRate: row.filter_pass_rate as number,
    discoveredFrom: row.discovered_from as "following" | "recommendation",
    discoveredAt: new Date(row.discovered_at as string),
    isFollowing: row.is_following as boolean,
    lastUpdated: new Date(row.last_updated as string),
  }));
}
