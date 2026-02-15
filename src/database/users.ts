import type { Pool } from "pg";
import type {
  DiscoveredUserData,
  UserData,
  UserProfileSnapshot,
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
 * Add a discovered user. On conflict, updates name, face, and profile fields.
 * is_following / followed_by are managed exclusively by syncFollowingStatus.
 */
export async function addDiscoveredUser(
  pool: Pool,
  user: DiscoveredUserData,
): Promise<void> {
  await pool.query(
    `INSERT INTO discovered_users
     (user_id, user_name, face, fans, sign, level, official_role, official_title,
      videos_seen, videos_filtered, filter_pass_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0.0)
     ON CONFLICT (user_id) DO UPDATE SET
       user_name = EXCLUDED.user_name,
       face = COALESCE(EXCLUDED.face, discovered_users.face),
       fans = GREATEST(EXCLUDED.fans, discovered_users.fans),
       sign = COALESCE(EXCLUDED.sign, discovered_users.sign),
       level = GREATEST(COALESCE(EXCLUDED.level, 0), COALESCE(discovered_users.level, 0)),
       official_role = CASE
         WHEN EXCLUDED.official_role IS NOT NULL AND EXCLUDED.official_role >= 0
         THEN EXCLUDED.official_role
         ELSE discovered_users.official_role
       END,
       official_title = COALESCE(NULLIF(EXCLUDED.official_title, ''), discovered_users.official_title)`,
    [
      user.userId.toString(),
      user.userName,
      user.face ?? null,
      user.fans ?? 0,
      user.sign ?? null,
      user.level ?? 0,
      user.officialRole ?? -1,
      user.officialTitle ?? null,
    ],
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
 * Sync following status for a specific crawler UID.
 *
 * - Adds crawlerUid to the `followed_by` array for users in followingIds.
 * - Removes crawlerUid from the `followed_by` array for users NOT in followingIds.
 * - Keeps `is_following` in sync: TRUE if followed_by is non-empty.
 */
export async function syncFollowingStatus(
  pool: Pool,
  crawlerUid: string,
  followingIds: Set<string>,
): Promise<void> {
  const crawlerUidBigint = BigInt(crawlerUid);
  const ids = Array.from(followingIds);

  // Add crawlerUid to followed_by for users now being followed by this crawler
  if (ids.length > 0) {
    await pool.query(
      `UPDATE discovered_users
       SET followed_by = array_append(array_remove(followed_by, $1), $1),
           is_following = TRUE
       WHERE user_id = ANY($2::BIGINT[])`,
      [crawlerUidBigint, ids],
    );
  }

  // Remove crawlerUid from followed_by for users no longer followed by this crawler
  await pool.query(
    `UPDATE discovered_users
     SET followed_by = array_remove(followed_by, $1),
         is_following = (cardinality(array_remove(followed_by, $1)) > 0)
     WHERE $1 = ANY(followed_by)
       AND NOT (user_id = ANY($2::BIGINT[]))`,
    [crawlerUidBigint, ids.length > 0 ? ids : ["0"]],
  );
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
    face: (row.face as string) ?? "",
    fans: row.fans as number,
    sign: (row.sign as string) ?? "",
    level: (row.level as number) ?? 0,
    officialRole: (row.official_role as number) ?? -1,
    officialTitle: (row.official_title as string) ?? "",
    videosSeen: row.videos_seen as number,
    videosFiltered: row.videos_filtered as number,
    filterPassRate: row.filter_pass_rate as number,
    discoveredAt: new Date(row.discovered_at),
    isFollowing: row.is_following as boolean,
    followedBy: (row.followed_by as string[] | null)?.map(BigInt) ?? [],
    lastUpdated: new Date(row.last_updated),
  }));
}

/**
 * Get profile history for a user, newest first.
 * @param limit Max number of snapshots to return (default 100)
 */
export async function getUserProfileHistory(
  pool: Pool,
  userId: bigint,
  limit = 100,
): Promise<UserProfileSnapshot[]> {
  const result = await pool.query(
    `SELECT id, user_id, recorded_at, user_name, face, fans,
            sign, level, official_role, official_title
     FROM user_profile_history
     WHERE user_id = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
    [userId.toString(), limit],
  );

  return result.rows.map((row) => ({
    id: BigInt(row.id),
    userId: BigInt(row.user_id),
    recordedAt: new Date(row.recorded_at),
    userName: row.user_name as string | null,
    face: row.face as string | null,
    fans: row.fans as number | null,
    sign: row.sign as string | null,
    level: row.level as number | null,
    officialRole: row.official_role as number | null,
    officialTitle: row.official_title as string | null,
  }));
}
