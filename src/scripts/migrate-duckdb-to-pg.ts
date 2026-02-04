/**
 * Migration script: DuckDB -> PostgreSQL
 *
 * Prerequisites:
 *   pnpm add -D @duckdb/node-api
 *
 * Usage:
 *   npx tsx src/scripts/migrate-duckdb-to-pg.ts --duckdb <path> --pg <url>
 *
 * Example:
 *   npx tsx src/scripts/migrate-duckdb-to-pg.ts \
 *     --duckdb ./exports/duckdb/12345.duckdb \
 *     --pg postgresql://localhost:5432/hantang
 *
 * After migration, you can remove duckdb:
 *   pnpm remove @duckdb/node-api
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { Pool } from "pg";

const BATCH_SIZE = 1000;

interface MigrationStats {
  processed_videos: number;
  forward_dynamics: number;
  recommendations: number;
  discovered_users: number;
}

function parseArgs(): { duckdbPath: string; pgUrl: string } {
  const args = process.argv.slice(2);
  let duckdbPath = "";
  let pgUrl = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--duckdb" && args[i + 1]) {
      duckdbPath = args[++i];
    } else if (args[i] === "--pg" && args[i + 1]) {
      pgUrl = args[++i];
    }
  }

  if (!duckdbPath || !pgUrl) {
    console.error("Usage: npx tsx src/scripts/migrate-duckdb-to-pg.ts --duckdb <path> --pg <url>");
    console.error("Example:");
    console.error("  npx tsx src/scripts/migrate-duckdb-to-pg.ts \\");
    console.error("    --duckdb ./exports/duckdb/12345.duckdb \\");
    console.error("    --pg postgresql://localhost:5432/hantang");
    process.exit(1);
  }

  return { duckdbPath, pgUrl };
}

async function initPgSchema(pool: Pool): Promise<void> {
  console.log("Initializing PostgreSQL schema...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_videos (
      aid BIGINT PRIMARY KEY,
      bvid VARCHAR UNIQUE NOT NULL,
      pubdate BIGINT,
      title VARCHAR,
      description TEXT,
      tag TEXT,
      pic VARCHAR,
      type_id INTEGER,
      user_id BIGINT,
      is_filtered BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      staff BIGINT[],
      tid_v2 INTEGER,
      dynamic TEXT,
      tag_new VARCHAR[],
      participle VARCHAR[],
      ctime BIGINT,
      is_deleted BOOLEAN DEFAULT FALSE,
      copyright INTEGER,
      extras JSONB,
      notes JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS forward_dynamics (
      forward_dynamic_id BIGINT PRIMARY KEY,
      original_bvid VARCHAR NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      video_bvid VARCHAR,
      recommended_by_bvid VARCHAR,
      recommend_count INTEGER DEFAULT 1,
      recommend_order INTEGER,
      first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_bvid, recommended_by_bvid)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_users (
      user_id BIGINT PRIMARY KEY,
      user_name VARCHAR,
      fans INTEGER DEFAULT 0,
      videos_seen INTEGER DEFAULT 0,
      videos_filtered INTEGER DEFAULT 0,
      filter_pass_rate REAL DEFAULT 0.0,
      discovered_from VARCHAR,
      discovered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      is_following BOOLEAN DEFAULT FALSE,
      last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Schema initialized.");
}

async function migrateProcessedVideos(
  duckConn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  pool: Pool,
): Promise<number> {
  console.log("Migrating processed_videos...");

  const countReader = await duckConn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM processed_videos",
  );
  const total = Number(countReader.getRows()[0]?.[0] ?? 0);
  console.log(`  Total rows: ${total}`);

  if (total === 0) return 0;

  let migrated = 0;
  let offset = 0;

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM processed_videos ORDER BY aid LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    for (const row of rows) {
      // Handle array conversions
      const staff = row.staff ? (row.staff as bigint[]).map(String) : null;
      const tagNew = row.tag_new as string[] | null;
      const participle = row.participle as string[] | null;

      // Handle JSON fields
      const extras = row.extras ? JSON.stringify(row.extras) : null;
      const notes = row.notes ? JSON.stringify(row.notes) : null;

      await pool.query(
        `INSERT INTO processed_videos
          (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered,
           created_at, updated_at, staff, tid_v2, dynamic, tag_new, participle, ctime,
           is_deleted, copyright, extras, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         ON CONFLICT (aid) DO NOTHING`,
        [
          String(row.aid),
          row.bvid,
          row.pubdate != null ? String(row.pubdate) : null,
          row.title,
          row.description,
          row.tag,
          row.pic,
          row.type_id != null ? Number(row.type_id) : null,
          row.user_id != null ? String(row.user_id) : null,
          row.is_filtered,
          row.created_at,
          row.updated_at,
          staff,
          row.tid_v2 != null ? Number(row.tid_v2) : null,
          row.dynamic,
          tagNew,
          participle,
          row.ctime != null ? String(row.ctime) : null,
          row.is_deleted ?? false,
          row.copyright != null ? Number(row.copyright) : null,
          extras,
          notes,
        ],
      );
      migrated++;
    }

    offset += BATCH_SIZE;
    process.stdout.write(`\r  Migrated: ${migrated}/${total}`);
  }

  console.log();
  return migrated;
}

async function migrateForwardDynamics(
  duckConn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  pool: Pool,
): Promise<number> {
  console.log("Migrating forward_dynamics...");

  const countReader = await duckConn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM forward_dynamics",
  );
  const total = Number(countReader.getRows()[0]?.[0] ?? 0);
  console.log(`  Total rows: ${total}`);

  if (total === 0) return 0;

  let migrated = 0;
  let offset = 0;

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM forward_dynamics ORDER BY forward_dynamic_id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    for (const row of rows) {
      await pool.query(
        `INSERT INTO forward_dynamics (forward_dynamic_id, original_bvid, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (forward_dynamic_id) DO NOTHING`,
        [String(row.forward_dynamic_id), row.original_bvid, row.created_at],
      );
      migrated++;
    }

    offset += BATCH_SIZE;
    process.stdout.write(`\r  Migrated: ${migrated}/${total}`);
  }

  console.log();
  return migrated;
}

async function migrateRecommendations(
  duckConn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  pool: Pool,
): Promise<number> {
  console.log("Migrating recommendations...");

  const countReader = await duckConn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM recommendations",
  );
  const total = Number(countReader.getRows()[0]?.[0] ?? 0);
  console.log(`  Total rows: ${total}`);

  if (total === 0) return 0;

  let migrated = 0;
  let offset = 0;

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM recommendations ORDER BY video_bvid, recommended_by_bvid LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    for (const row of rows) {
      await pool.query(
        `INSERT INTO recommendations
          (video_bvid, recommended_by_bvid, recommend_count, recommend_order, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (video_bvid, recommended_by_bvid) DO NOTHING`,
        [
          row.video_bvid,
          row.recommended_by_bvid,
          row.recommend_count,
          row.recommend_order,
          row.first_seen,
          row.last_seen,
        ],
      );
      migrated++;
    }

    offset += BATCH_SIZE;
    process.stdout.write(`\r  Migrated: ${migrated}/${total}`);
  }

  console.log();
  return migrated;
}

async function migrateDiscoveredUsers(
  duckConn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  pool: Pool,
): Promise<number> {
  console.log("Migrating discovered_users...");

  const countReader = await duckConn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM discovered_users",
  );
  const total = Number(countReader.getRows()[0]?.[0] ?? 0);
  console.log(`  Total rows: ${total}`);

  if (total === 0) return 0;

  let migrated = 0;
  let offset = 0;

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM discovered_users ORDER BY user_id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    for (const row of rows) {
      await pool.query(
        `INSERT INTO discovered_users
          (user_id, user_name, fans, videos_seen, videos_filtered, filter_pass_rate,
           discovered_from, discovered_at, is_following, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          String(row.user_id),
          row.user_name,
          row.fans,
          row.videos_seen,
          row.videos_filtered,
          row.filter_pass_rate,
          row.discovered_from,
          row.discovered_at,
          row.is_following,
          row.last_updated,
        ],
      );
      migrated++;
    }

    offset += BATCH_SIZE;
    process.stdout.write(`\r  Migrated: ${migrated}/${total}`);
  }

  console.log();
  return migrated;
}

async function main() {
  const { duckdbPath, pgUrl } = parseArgs();

  console.log("=== DuckDB to PostgreSQL Migration ===");
  console.log(`DuckDB: ${duckdbPath}`);
  console.log(`PostgreSQL: ${pgUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log();

  // Connect to DuckDB
  console.log("Connecting to DuckDB...");
  const duckdb = await DuckDBInstance.create(duckdbPath, { access_mode: "READ_ONLY" });
  const duckConn = await duckdb.connect();

  // Connect to PostgreSQL
  console.log("Connecting to PostgreSQL...");
  const pool = new Pool({
    connectionString: pgUrl,
    max: 5,
  });
  await pool.query("SELECT 1"); // Test connection

  console.log("Connected.\n");

  // Initialize schema
  await initPgSchema(pool);
  console.log();

  // Migrate tables
  const stats: MigrationStats = {
    processed_videos: 0,
    forward_dynamics: 0,
    recommendations: 0,
    discovered_users: 0,
  };

  stats.processed_videos = await migrateProcessedVideos(duckConn, pool);
  stats.forward_dynamics = await migrateForwardDynamics(duckConn, pool);
  stats.recommendations = await migrateRecommendations(duckConn, pool);
  stats.discovered_users = await migrateDiscoveredUsers(duckConn, pool);

  // Create indexes
  console.log("\nCreating indexes...");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_processed_bvid ON processed_videos(bvid)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_processed_user ON processed_videos(user_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_processed_filtered ON processed_videos(is_filtered)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_forward_bvid ON forward_dynamics(original_bvid)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_rec_video ON recommendations(video_bvid)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_rec_count ON recommendations(recommend_count DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_user_source ON discovered_users(discovered_from)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_user_rate ON discovered_users(filter_pass_rate DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_user_fans ON discovered_users(fans DESC)");
  console.log("Indexes created.");

  // Summary
  console.log("\n=== Migration Complete ===");
  console.log(`processed_videos: ${stats.processed_videos} rows`);
  console.log(`forward_dynamics: ${stats.forward_dynamics} rows`);
  console.log(`recommendations: ${stats.recommendations} rows`);
  console.log(`discovered_users: ${stats.discovered_users} rows`);

  // Cleanup
  await pool.end();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
