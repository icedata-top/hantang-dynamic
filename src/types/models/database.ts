/**
 * Discovered user data for tracking new UP主
 */
export interface DiscoveredUserData {
  userId: bigint;
  userName: string;
  fans: number;
  source: "following" | "recommendation";
}

/**
 * User statistics update
 */
export interface UserStatsUpdate {
  videosSeen?: number;
  videosFiltered?: number;
  fans?: number;
  userName?: string;
}

/**
 * Recommendation data
 */
export interface RecommendationData {
  videoBvid: string;
  recommendedByBvid: string;
  recommendCount: number;
  recommendOrder: number;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * User data with statistics
 */
export interface UserData {
  userId: bigint;
  userName: string;
  fans: number;
  videosSeen: number;
  videosFiltered: number;
  filterPassRate: number;
  discoveredFrom: "following" | "recommendation";
  discoveredAt: Date;
  isFollowing: boolean;
  lastUpdated: Date;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  processedVideosCount: number;
  forwardDynamicsCount: number;
  recommendationsCount: number;
  discoveredUsersCount: number;
  filteredVideosCount: number;
}
