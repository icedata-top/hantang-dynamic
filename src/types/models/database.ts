/**
 * Discovered user data for tracking new UP主
 */
export interface DiscoveredUserData {
  userId: bigint;
  userName: string;
  face?: string;
  fans?: number;
  sign?: string;
  level?: number;
  officialRole?: number;
  officialTitle?: string;
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
  face: string;
  fans: number;
  sign: string;
  level: number;
  officialRole: number;
  officialTitle: string;
  videosSeen: number;
  videosFiltered: number;
  filterPassRate: number;
  discoveredAt: Date;
  isFollowing: boolean;
  /** Which crawler UIDs are currently following this user */
  followedBy: bigint[];
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
