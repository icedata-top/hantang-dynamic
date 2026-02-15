import type { Pool } from "pg";
import type { VideoSnapshot } from "../types/models/database.js";
import type { VideoData } from "../types/models/video.js";
import { bv2av } from "../utils/bvid.js";

/**
 * Check if a video has been processed
 */
export async function hasProcessedVideo(
  pool: Pool,
  bvid: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT COUNT(*) as count FROM processed_videos WHERE bvid = $1",
    [bvid],
  );

  return Number.parseInt(result.rows[0]?.count || "0", 10) > 0;
}

/**
 * Check if a video has been processed by ID (AID or BVID)
 */
export async function hasProcessedVideoById(
  pool: Pool,
  id: string | number | bigint,
): Promise<boolean> {
  const isBvid = typeof id === "string" && id.startsWith("BV");
  const sql = isBvid
    ? "SELECT COUNT(*) as count FROM processed_videos WHERE bvid = $1"
    : "SELECT COUNT(*) as count FROM processed_videos WHERE aid = $1";

  const param = isBvid ? id : BigInt(id).toString();

  const result = await pool.query(sql, [param]);
  return Number.parseInt(result.rows[0]?.count || "0", 10) > 0;
}

/**
 * Get all processed video IDs of a specific type (aid or bvid)
 */
export async function getAllProcessedIds(
  pool: Pool,
  type: "aid" | "bvid",
): Promise<Set<string>> {
  const column = type === "aid" ? "aid" : "bvid";
  const result = await pool.query(`SELECT ${column} FROM processed_videos`);

  const ids = new Set<string>();
  for (const row of result.rows) {
    if (row[column] !== null && row[column] !== undefined) {
      ids.add(row[column].toString());
    }
  }

  return ids;
}

/**
 * Mark a video as processed
 */
export async function markVideoProcessed(
  pool: Pool,
  video: VideoData,
  filtered: boolean,
): Promise<void> {
  await pool.query(
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
    [
      BigInt(video.aid).toString(),
      video.bvid,
      video.pubdate,
      video.title,
      video.description,
      video.tag,
      video.pic,
      video.type_id,
      BigInt(video.user_id).toString(),
      filtered,
      video.staff ? video.staff.map((s) => s.toString()) : null,
      video.tid_v2 ?? null,
      video.dynamic ?? null,
      video.tag_new ?? null,
      video.participle ?? null,
      video.ctime ?? null,
      video.is_deleted ?? false,
      video.copyright ?? null,
      video.extras ? JSON.stringify(video.extras) : null,
      video.notes ? JSON.stringify(video.notes) : null,
    ],
  );
}

/**
 * Get processed videos
 */
export async function getProcessedVideos(
  pool: Pool,
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

  const result = await pool.query(sql);

  return result.rows.map((row) => ({
    aid: BigInt(row.aid),
    bvid: row.bvid as string,
    pubdate: row.pubdate as number,
    title: row.title as string,
    description: row.description as string,
    tag: row.tag as string,
    pic: row.pic as string,
    type_id: row.type_id as number,
    user_id: BigInt(row.user_id),
    staff: row.staff ? row.staff.map((s: string) => BigInt(s)) : undefined,
    tid_v2: row.tid_v2 as number | undefined,
    dynamic: row.dynamic as string | undefined,
    tag_new: row.tag_new as string[] | undefined,
    participle: row.participle as string[] | undefined,
    ctime: row.ctime as number | undefined,
    is_deleted: row.is_deleted as boolean | undefined,
    copyright: row.copyright as number | undefined,
    extras: row.extras ? row.extras : undefined,
    notes: row.notes ? row.notes : undefined,
  }));
}

/**
 * Mark a video as deleted, preserving existing fields if the row already exists.
 * Sets aid to the value computed from bvid.
 * Note: if stale aid collisions exist, run `--repair --fix-aids` first.
 */
export async function markVideoDeleted(
  pool: Pool,
  bvid: string,
  notes?: { api_code?: number; api_message?: string },
): Promise<void> {
  const notesJson = notes ? JSON.stringify(notes) : null;
  const correctAid = bv2av(bvid);

  await pool.query(
    `INSERT INTO processed_videos (aid, bvid, is_filtered, is_deleted, notes)
     VALUES ($1, $2, false, true, $3)
     ON CONFLICT (bvid) DO UPDATE SET
       aid = EXCLUDED.aid,
       is_deleted = true,
       notes = EXCLUDED.notes,
       updated_at = NOW()`,
    [correctAid.toString(), bvid, notesJson],
  );
}

/**
 * Get list of bvids only (lightweight, for batch processing)
 */
export async function getBvidList(
  pool: Pool,
  where?: string,
): Promise<string[]> {
  let sql = "SELECT bvid FROM processed_videos";
  if (where) {
    sql += ` WHERE ${where}`;
  }
  sql += " ORDER BY created_at DESC";

  const result = await pool.query(sql);
  return result.rows.map((row) => row.bvid as string);
}

/**
 * Get change history for a video, newest first.
 * @param limit Max number of snapshots to return (default 50)
 */
export async function getVideoHistory(
  pool: Pool,
  bvid: string,
  limit = 50,
): Promise<VideoSnapshot[]> {
  const result = await pool.query(
    `SELECT id, aid, bvid, recorded_at, title, description, tag, tag_new,
            pic, is_deleted, is_filtered, extras, notes
     FROM video_history
     WHERE bvid = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
    [bvid, limit],
  );

  return result.rows.map((row) => ({
    id: BigInt(row.id),
    aid: BigInt(row.aid),
    bvid: row.bvid as string,
    recordedAt: new Date(row.recorded_at),
    title: row.title as string | null,
    description: row.description as string | null,
    tag: row.tag as string | null,
    tagNew: row.tag_new as string[] | null,
    pic: row.pic as string | null,
    isDeleted: row.is_deleted as boolean | null,
    isFiltered: row.is_filtered as boolean | null,
    extras: row.extras as Record<string, unknown> | null,
    notes: row.notes as Record<string, unknown> | null,
  }));
}
