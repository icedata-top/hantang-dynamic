import type { DuckDBConnection } from "@duckdb/node-api";
import { listValue } from "@duckdb/node-api";
import type { VideoData } from "../types/models/video.js";

/**
 * Check if a video has been processed
 */
export async function hasProcessedVideo(
  connection: DuckDBConnection,
  bvid: string,
): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    "SELECT COUNT(*) as count FROM processed_videos WHERE bvid = $1",
    { 1: bvid },
  );

  const rows = reader.getRows();
  return (rows[0]?.[0] as number) > 0;
}

/**
 * Check if a video has been processed by ID (AID or BVID)
 */
export async function hasProcessedVideoById(
  connection: DuckDBConnection,
  id: string | number | bigint,
): Promise<boolean> {
  const isBvid = typeof id === "string" && id.startsWith("BV");
  const sql = isBvid
    ? "SELECT COUNT(*) as count FROM processed_videos WHERE bvid = $1"
    : "SELECT COUNT(*) as count FROM processed_videos WHERE aid = $1";

  const param = isBvid ? id : BigInt(id);

  const reader = await connection.runAndReadAll(sql, { 1: param });

  const rows = reader.getRows();
  return (rows[0]?.[0] as number) > 0;
}

/**
 * Get all processed video IDs of a specific type (aid or bvid)
 */
export async function getAllProcessedIds(
  connection: DuckDBConnection,
  type: "aid" | "bvid",
): Promise<Set<string>> {
  const column = type === "aid" ? "aid" : "bvid";
  // Select only the specific column to minimize data transfer
  const reader = await connection.runAndReadAll(
    `SELECT ${column} FROM processed_videos`,
  );

  const rows = reader.getRows();
  const ids = new Set<string>();

  for (const row of rows) {
    if (row[0] !== null && row[0] !== undefined) {
      ids.add(row[0].toString());
    }
  }

  return ids;
}

/**
 * Mark a video as processed
 */
export async function markVideoProcessed(
  connection: DuckDBConnection,
  video: VideoData,
  filtered: boolean,
): Promise<void> {
  await connection.run(
    `
    INSERT INTO processed_videos 
      (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered, 
       staff, tid_v2, dynamic, tag_new, participle, ctime, is_deleted, copyright, extras, notes, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())
    ON CONFLICT (bvid) DO UPDATE SET
      aid = EXCLUDED.aid,
      pubdate = EXCLUDED.pubdate,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tag = EXCLUDED.tag,
      pic = EXCLUDED.pic,
      type_id = EXCLUDED.type_id,
      user_id = EXCLUDED.user_id,
      is_filtered = EXCLUDED.is_filtered,
      staff = EXCLUDED.staff,
      tid_v2 = EXCLUDED.tid_v2,
      dynamic = EXCLUDED.dynamic,
      tag_new = EXCLUDED.tag_new,
      participle = EXCLUDED.participle,
      ctime = EXCLUDED.ctime,
      is_deleted = EXCLUDED.is_deleted,
      copyright = EXCLUDED.copyright,
      extras = EXCLUDED.extras,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `,
    {
      1: BigInt(video.aid),
      2: video.bvid,
      3: video.pubdate,
      4: video.title,
      5: video.description,
      6: video.tag,
      7: video.pic,
      8: video.type_id,
      9: BigInt(video.user_id),
      10: filtered,
      11: video.staff ? listValue(video.staff) : null,
      12: video.tid_v2 ?? null,
      13: video.dynamic ?? null,
      14: video.tag_new ? listValue(video.tag_new) : null,
      15: video.participle ? listValue(video.participle) : null,
      16: video.ctime ?? null,
      17: video.is_deleted ?? false,
      18: video.copyright ?? null,
      19: video.extras ? JSON.stringify(video.extras) : null,
      20: video.notes ? JSON.stringify(video.notes) : null,
    },
  );
}

/**
 * Get processed videos
 */
export async function getProcessedVideos(
  connection: DuckDBConnection,
  limit?: number,
  where?: string,
): Promise<VideoData[]> {
  let sql = "SELECT * FROM processed_videos";

  if (where) {
    sql += ` WHERE ${where}`;
  }

  sql += " ORDER BY created_at DESC";

  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  const reader = await connection.runAndReadAll(sql);
  const rows = reader.getRowObjects();

  return rows.map((row) => ({
    aid: row.aid as bigint,
    bvid: row.bvid as string,
    pubdate: row.pubdate as number,
    title: row.title as string,
    description: row.description as string,
    tag: row.tag as string,
    pic: row.pic as string,
    type_id: row.type_id as number,
    user_id: row.user_id as bigint,
    staff: (row.staff as bigint[] | null) ?? undefined,
    tid_v2: row.tid_v2 as number | undefined,
    dynamic: row.dynamic as string | undefined,
    tag_new: (row.tag_new as string[] | null) ?? undefined,
    participle: (row.participle as string[] | null) ?? undefined,
    ctime: row.ctime as number | undefined,
    is_deleted: row.is_deleted as boolean | undefined,
    copyright: row.copyright as number | undefined,
    extras: row.extras ? JSON.parse(row.extras as string) : undefined,
    notes: row.notes ? JSON.parse(row.notes as string) : undefined,
  }));
}

/**
 * Get list of bvids only (lightweight, for batch processing)
 */
export async function getBvidList(
  connection: DuckDBConnection,
  where?: string,
): Promise<string[]> {
  let sql = "SELECT bvid FROM processed_videos";
  if (where) {
    sql += ` WHERE ${where}`;
  }
  sql += " ORDER BY created_at DESC";

  const reader = await connection.runAndReadAll(sql);
  const rows = reader.getRows();
  return rows.map((row) => row[0] as string);
}
