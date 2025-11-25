import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/core/database.js";
import type { VideoData } from "../src/types/models/video.js";

const TEST_DB_DIR = join(__dirname, "tmp");
const TEST_DB_PATH = join(TEST_DB_DIR, "test.duckdb");

describe("Database", () => {
  let db: Database;

  beforeAll(async () => {
    // Clean up any leftover test database from previous runs
    try {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Create test directory
    mkdirSync(TEST_DB_DIR, { recursive: true });

    // Initialize database
    db = Database.getInstance();
    await db.init(TEST_DB_PATH);
  });

  afterAll(async () => {
    // Close database and wait for handles to be released
    await db.close();

    // Give the OS time to release file handles
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean up test database with retry
    try {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    } catch (_error) {
      // If cleanup fails, try again after a delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        rmSync(TEST_DB_DIR, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors in tests
        console.warn("Could not clean up test database directory");
      }
    }
  });

  describe("Schema Initialization", () => {
    it("should create all required tables", async () => {
      const conn = db.getConnection();

      // Check processed_videos table exists
      const result1 = await conn.runAndReadAll(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'processed_videos'
      `);
      expect(result1.getRows().length).toBe(1);

      // Check forward_dynamics table exists
      const result2 = await conn.runAndReadAll(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'forward_dynamics'
      `);
      expect(result2.getRows().length).toBe(1);

      // Check recommendations table exists
      const result3 = await conn.runAndReadAll(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'recommendations'
      `);
      expect(result3.getRows().length).toBe(1);

      // Check discovered_users table exists
      const result4 = await conn.runAndReadAll(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'discovered_users'
      `);
      expect(result4.getRows().length).toBe(1);
    });
  });

  describe("Video Processing", () => {
    const testVideo: VideoData = {
      aid: BigInt(12345678),
      bvid: "BV1testbvid123",
      pubdate: Math.floor(Date.now() / 1000),
      title: "Test Video Title",
      description: "Test video description",
      tag: "tag1;tag2;tag3",
      pic: "https://example.com/pic.jpg",
      type_id: 1,
      user_id: BigInt(87654321),
    };

    it("should mark a video as processed", async () => {
      await db.markVideoProcessed(testVideo, true);

      const exists = await db.hasProcessedVideo(testVideo.bvid);
      expect(exists).toBe(true);
    });

    it("should detect unprocessed videos", async () => {
      const exists = await db.hasProcessedVideo("BV_nonexistent");
      expect(exists).toBe(false);
    });

    it("should retrieve processed videos", async () => {
      const videos = await db.getProcessedVideos(10);
      expect(videos.length).toBeGreaterThan(0);
      expect(videos[0]?.bvid).toBe(testVideo.bvid);
    });
  });

  describe("Forward Dynamics Caching", () => {
    it("should cache forward dynamic relationships", async () => {
      await db.cacheForward("123456789", "BV1forward123");

      const cached = await db.getCachedForwardBvid("123456789");
      expect(cached).toBe("BV1forward123");
    });

    it("should return null for uncached forward dynamics", async () => {
      const cached = await db.getCachedForwardBvid("999999999");
      expect(cached).toBeNull();
    });
  });

  describe("Recommendation Tracking", () => {
    it("should track recommendation relationships", async () => {
      await db.trackRecommendation("BV1video1", "BV1source1", 1);
      await db.trackRecommendation("BV1video1", "BV1source2", 2);

      const recommendations = await db.getTopRecommendedVideos(10);
      expect(recommendations.length).toBeGreaterThan(0);
    });

    it("should increment recommendation count on duplicate", async () => {
      await db.trackRecommendation("BV1video2", "BV1source3", 1);
      await db.trackRecommendation("BV1video2", "BV1source3", 1);

      const recommendations = await db.getTopRecommendedVideos(10);
      const rec = recommendations.find(
        (r) =>
          r.videoBvid === "BV1video2" && r.recommendedByBvid === "BV1source3",
      );

      expect(rec?.recommendCount).toBe(2);
    });
  });

  describe("User Discovery", () => {
    const testUser = {
      userId: BigInt(11111111),
      userName: "Test User",
      fans: 1000,
      source: "following" as const,
    };

    it("should add a discovered user", async () => {
      await db.addDiscoveredUser(testUser);

      const exists = await db.hasUser(testUser.userId);
      expect(exists).toBe(true);
    });

    it("should update user statistics", async () => {
      await db.updateUserStats(testUser.userId, {
        videosSeen: 10,
        videosFiltered: 7,
      });

      const users = await db.getTopDiscoveredUsers("filter_pass_rate", 10);
      const user = users.find((u) => u.userId === testUser.userId);

      expect(user?.videosSeen).toBe(10);
      expect(user?.videosFiltered).toBe(7);
      expect(user?.filterPassRate).toBeCloseTo(0.7, 5);
    });

    it("should retrieve top users by filter pass rate", async () => {
      const users = await db.getTopDiscoveredUsers("filter_pass_rate", 5);
      expect(users.length).toBeGreaterThan(0);
    });

    it("should retrieve top users by fans", async () => {
      const users = await db.getTopDiscoveredUsers("fans", 5);
      expect(users.length).toBeGreaterThan(0);
    });
  });

  describe("Database Statistics", () => {
    it("should return accurate database statistics", async () => {
      const stats = await db.getStats();

      expect(stats.processedVideosCount).toBeGreaterThan(0);
      expect(stats.forwardDynamicsCount).toBeGreaterThan(0);
      expect(stats.recommendationsCount).toBeGreaterThan(0);
      expect(stats.discoveredUsersCount).toBeGreaterThan(0);
    });
  });
});
