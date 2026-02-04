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

const BATCH_SIZE = 2000;

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * 安全的 JSON 序列化
 */
function safeJsonStringify(obj: any): string | null {
  if (!obj) return null;
  const json = JSON.stringify(
    obj,
    (key, value) => typeof value === "bigint" ? value.toString() : value,
  );
  // Remove null bytes which are not allowed in Postgres JSONB
  return json.replace(/\u0000/g, "");
}

/**
 * Remove null bytes from string which Postgres doesn't support
 */
function sanitizeString(val: any): string | null {
  if (val === null || val === undefined) return null;
  const str = typeof val === "bigint" ? val.toString() : String(val);
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u0000/g, "");
}

/**
 * 转换 DuckDB 时间戳到 PostgreSQL 格式
 */
function convertTimestamp(ts: any): Date | null {
  if (!ts) return null;

  if (ts instanceof Date) return ts;

  // DuckDB timestamp object with micros
  if (typeof ts === "object" && ts.micros) {
    const micros = BigInt(ts.micros);
    const millis = Number(micros / 1000n);
    return new Date(millis);
  }

  if (typeof ts === "string") {
    return new Date(ts);
  }

  if (typeof ts === "number") {
    return new Date(ts);
  }

  return null;
}

function convertArray(arr: any): string[] | null {
  if (!arr) return null;

  // 如果已经是数组
  if (Array.isArray(arr)) {
    return arr.map((v: any) => sanitizeString(v) || "");
  }

  // 如果是 DuckDB 的对象格式 {"items": [...]}
  if (typeof arr === "object" && arr.items && Array.isArray(arr.items)) {
    return arr.items.map((v: any) => sanitizeString(v) || "");
  }

  return null;
}

/**
 * Format elapsed time to human-readable ETA string
 */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

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
    console.error(
      "Usage: npx tsx src/scripts/migrate-duckdb-to-pg.ts --duckdb <path> --pg <url>",
    );
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
  const tableStartTime = Date.now();

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM processed_videos ORDER BY aid LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 准备批量数据
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Handle array conversions
        const staff = convertArray(row.staff);
        const tagNew = convertArray(row.tag_new);
        const participle = convertArray(row.participle);

        // Handle JSON fields
        const extras = safeJsonStringify(row.extras);
        const notes = safeJsonStringify(row.notes);

        // Convert timestamps
        const createdAt = convertTimestamp(row.created_at);
        const updatedAt = convertTimestamp(row.updated_at);

        const rowValues = [
          String(row.aid),
          String(row.bvid),
          row.pubdate != null ? String(row.pubdate) : null,
          sanitizeString(row.title),
          sanitizeString(row.description),
          sanitizeString(row.tag),
          sanitizeString(row.pic),
          row.type_id != null ? Number(row.type_id) : null,
          row.user_id != null ? String(row.user_id) : null,
          row.is_filtered,
          createdAt,
          updatedAt,
          staff,
          row.tid_v2 != null ? Number(row.tid_v2) : null,
          sanitizeString(row.dynamic),
          tagNew,
          participle,
          row.ctime != null ? String(row.ctime) : null,
          row.is_deleted ?? false,
          row.copyright != null ? Number(row.copyright) : null,
          extras,
          notes,
        ];

        values.push(...rowValues);

        // 生成占位符 ($1, $2, ..., $22), ($23, $24, ..., $44), ...
        const placeholderGroup = Array.from(
          { length: 22 },
          (_, j) => `$${paramIndex + j}`,
        ).join(", ");
        placeholders.push(`(${placeholderGroup})`);
        paramIndex += 22;
      }

      // 执行批量插入
      const query = `
        INSERT INTO processed_videos
          (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered,
           created_at, updated_at, staff, tid_v2, dynamic, tag_new, participle, ctime,
           is_deleted, copyright, extras, notes)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (aid) DO NOTHING
      `;

      await client.query(query, values);
      await client.query("COMMIT");

      migrated += rows.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    offset += BATCH_SIZE;
    const elapsed = (Date.now() - tableStartTime) / 1000;
    const rate = migrated / elapsed;
    const remaining = total - migrated;
    const eta = formatEta(remaining / rate);
    process.stdout.write(`\r  Migrated: ${migrated}/${total} | ETA: ${eta}   `);
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
  const tableStartTime = Date.now();

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM forward_dynamics ORDER BY forward_dynamic_id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const createdAt = convertTimestamp(row.created_at);

        values.push(
          String(row.forward_dynamic_id),
          sanitizeString(row.original_bvid),
          createdAt,
        );

        const placeholderGroup = `($${paramIndex}, $${paramIndex + 1}, $${
          paramIndex + 2
        })`;
        placeholders.push(placeholderGroup);
        paramIndex += 3;
      }

      const query = `
        INSERT INTO forward_dynamics (forward_dynamic_id, original_bvid, created_at)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (forward_dynamic_id) DO NOTHING
      `;

      await client.query(query, values);
      await client.query("COMMIT");

      migrated += rows.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    offset += BATCH_SIZE;
    const elapsed = (Date.now() - tableStartTime) / 1000;
    const rate = migrated / elapsed;
    const remaining = total - migrated;
    const eta = formatEta(remaining / rate);
    process.stdout.write(`\r  Migrated: ${migrated}/${total} | ETA: ${eta}   `);
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
  const tableStartTime = Date.now();

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM recommendations ORDER BY video_bvid, recommended_by_bvid LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const firstSeen = convertTimestamp(row.first_seen);
        const lastSeen = convertTimestamp(row.last_seen);

        values.push(
          sanitizeString(row.video_bvid),
          sanitizeString(row.recommended_by_bvid),
          row.recommend_count,
          row.recommend_order,
          firstSeen,
          lastSeen,
        );

        const placeholderGroup = Array.from(
          { length: 6 },
          (_, j) => `$${paramIndex + j}`,
        ).join(", ");
        placeholders.push(`(${placeholderGroup})`);
        paramIndex += 6;
      }

      const query = `
        INSERT INTO recommendations
          (video_bvid, recommended_by_bvid, recommend_count, recommend_order, first_seen, last_seen)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (video_bvid, recommended_by_bvid) DO NOTHING
      `;

      await client.query(query, values);
      await client.query("COMMIT");

      migrated += rows.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    offset += BATCH_SIZE;
    const elapsed = (Date.now() - tableStartTime) / 1000;
    const rate = migrated / elapsed;
    const remaining = total - migrated;
    const eta = formatEta(remaining / rate);
    process.stdout.write(`\r  Migrated: ${migrated}/${total} | ETA: ${eta}   `);
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
  const tableStartTime = Date.now();

  while (offset < total) {
    const reader = await duckConn.runAndReadAll(
      `SELECT * FROM discovered_users ORDER BY user_id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );
    const rows = reader.getRowObjects();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const discoveredAt = convertTimestamp(row.discovered_at);
        const lastUpdated = convertTimestamp(row.last_updated);

        values.push(
          String(row.user_id),
          sanitizeString(row.user_name),
          row.fans,
          row.videos_seen,
          row.videos_filtered,
          row.filter_pass_rate,
          sanitizeString(row.discovered_from),
          discoveredAt,
          row.is_following,
          lastUpdated,
        );

        const placeholderGroup = Array.from(
          { length: 10 },
          (_, j) => `$${paramIndex + j}`,
        ).join(", ");
        placeholders.push(`(${placeholderGroup})`);
        paramIndex += 10;
      }

      const query = `
        INSERT INTO discovered_users
          (user_id, user_name, fans, videos_seen, videos_filtered, filter_pass_rate,
           discovered_from, discovered_at, is_following, last_updated)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (user_id) DO NOTHING
      `;

      await client.query(query, values);
      await client.query("COMMIT");

      migrated += rows.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    offset += BATCH_SIZE;
    const elapsed = (Date.now() - tableStartTime) / 1000;
    const rate = migrated / elapsed;
    const remaining = total - migrated;
    const eta = formatEta(remaining / rate);
    process.stdout.write(`\r  Migrated: ${migrated}/${total} | ETA: ${eta}   `);
  }

  console.log();
  return migrated;
}

async function main() {
  const { duckdbPath, pgUrl } = parseArgs();

  console.log("=== DuckDB to PostgreSQL Migration (Optimized) ===");
  console.log(`DuckDB: ${duckdbPath}`);
  console.log(`PostgreSQL: ${pgUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log();

  // Connect to DuckDB
  console.log("Connecting to DuckDB...");
  const duckdb = await DuckDBInstance.create(duckdbPath, {
    access_mode: "READ_ONLY",
  });
  const duckConn = await duckdb.connect();

  // Connect to PostgreSQL
  console.log("Connecting to PostgreSQL...");
  const pool = new Pool({
    connectionString: pgUrl,
    max: 20,
  });
  await pool.query("SELECT 1"); // Test connection

  console.log("Connected.\n");

  // Initialize schema
  await initPgSchema(pool);
  console.log();

  const startTime = Date.now();

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
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_processed_bvid ON processed_videos(bvid)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_processed_user ON processed_videos(user_id)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_processed_filtered ON processed_videos(is_filtered)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_forward_bvid ON forward_dynamics(original_bvid)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_rec_video ON recommendations(video_bvid)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_rec_count ON recommendations(recommend_count DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_user_source ON discovered_users(discovered_from)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_user_rate ON discovered_users(filter_pass_rate DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_user_fans ON discovered_users(fans DESC)",
  );
  console.log("Indexes created.");

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  // Summary
  console.log("\n=== Migration Complete ===");
  console.log(`processed_videos: ${stats.processed_videos} rows`);
  console.log(`forward_dynamics: ${stats.forward_dynamics} rows`);
  console.log(`recommendations: ${stats.recommendations} rows`);
  console.log(`discovered_users: ${stats.discovered_users} rows`);
  console.log(`\nTotal time: ${duration}s`);

  // Cleanup
  await pool.end();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
