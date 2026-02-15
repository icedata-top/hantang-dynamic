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
  videoAid: bigint;
  recommendedByAid: bigint;
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
 * A single snapshot entry from video_history
 */
export interface VideoSnapshot {
  id: bigint;
  aid: bigint;
  bvid: string;
  recordedAt: Date;
  title: string | null;
  description: string | null;
  tag: string | null;
  tagNew: string[] | null;
  pic: string | null;
  isDeleted: boolean | null;
  isFiltered: boolean | null;
  extras: Record<string, unknown> | null;
  notes: Record<string, unknown> | null;
}

/**
 * A single snapshot entry from user_profile_history
 */
export interface UserProfileSnapshot {
  id: bigint;
  userId: bigint;
  recordedAt: Date;
  userName: string | null;
  face: string | null;
  fans: number | null;
  sign: string | null;
  level: number | null;
  officialRole: number | null;
  officialTitle: string | null;
}

/**
 * Dynamic post data for storage in the dynamics table
 */
export interface DynamicData {
  dynamicId: bigint;
  userId: bigint;
  type: number;
  timestamp: number;
  /** Referenced video BVID (type=8), or resolved original BVID (type=1 after resolution) */
  bvid?: string;
  /** Original dynamic ID being forwarded (type=1) */
  origDynamicId?: bigint;
  /** Type of the original dynamic (type=1) */
  origType?: number;
  /** Caption text (type=8) or post body (type=4) or article summary (type=64) */
  textContent?: string;
  /** Article title (type=64) */
  title?: string;
  /** Text written when forwarding (type=1) */
  forwardText?: string;
  /** Image list (type=2) */
  images?: Array<{ img_src: string; img_width?: number; img_height?: number }>;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  processedVideosCount: number;
  dynamicsCount: number;
  recommendationsCount: number;
  discoveredUsersCount: number;
  filteredVideosCount: number;
}
