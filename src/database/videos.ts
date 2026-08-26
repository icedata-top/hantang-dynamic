import type { Pool, PoolClient } from "pg";
import type { VideoSnapshot } from "../types/models/database.js";
import type { VideoData } from "../types/models/video.js";
import {
  type DatabaseQuery,
  type ProcessedVideoCollectionOptions,
  upsertCollectionStateFromProcessedVideo,
} from "./collectionState.js";

export interface BvidListQuery {
  where?: string;
  params?: unknown[];
  limit?: number;
}

export type VideoIdentity =
  | { type: "aid"; aid: bigint }
  | { type: "bvid"; bvid: string };

export interface VideoDeletionNotes {
  api_code?: number;
  api_message?: string;
}

/**
 * Check if a video has been processed
 */
export async function hasProcessedVideo(
  pool: Pool,
  bvid: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT EXISTS(SELECT 1 FROM processed_videos WHERE bvid = $1) AS exists",
    [bvid],
  );

  return result.rows[0]?.exists === true;
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
    ? "SELECT EXISTS(SELECT 1 FROM processed_videos WHERE bvid = $1) AS exists"
    : "SELECT EXISTS(SELECT 1 FROM processed_videos WHERE aid = $1) AS exists";

  const param = isBvid ? id : BigInt(id).toString();

  const result = await pool.query(sql, [param]);
  return result.rows[0]?.exists === true;
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
  pool: DatabaseQuery,
  video: VideoData,
  filtered: boolean,
): Promise<void> {
  await pool.query(
    `
    INSERT INTO processed_videos 
      (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered, 
       staff, tid_v2, dynamic, tag_new, participle, ctime, is_deleted, copyright,
       pid_v2, mission_id, extras, notes, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
    ON CONFLICT (bvid) DO UPDATE SET
      aid = EXCLUDED.aid,
      pubdate = EXCLUDED.pubdate,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tag = CASE
        WHEN $23::boolean THEN EXCLUDED.tag
        ELSE processed_videos.tag
      END,
      pic = EXCLUDED.pic,
      type_id = EXCLUDED.type_id,
      user_id = EXCLUDED.user_id,
      is_filtered = EXCLUDED.is_filtered,
      staff = EXCLUDED.staff,
      tid_v2 = EXCLUDED.tid_v2,
      dynamic = EXCLUDED.dynamic,
      tag_new = CASE
        WHEN $23::boolean THEN EXCLUDED.tag_new
        ELSE processed_videos.tag_new
      END,
      participle = EXCLUDED.participle,
      ctime = EXCLUDED.ctime,
      is_deleted = EXCLUDED.is_deleted,
      copyright = EXCLUDED.copyright,
      pid_v2 = COALESCE(EXCLUDED.pid_v2, processed_videos.pid_v2),
      mission_id = EXCLUDED.mission_id,
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
      video.pid_v2 ?? null,
      video.mission_id?.toString() ?? null,
      video.extras ? JSON.stringify(video.extras) : null,
      video.notes ? JSON.stringify(video.notes) : null,
      video.tagSnapshot !== undefined,
    ],
  );

  if (video.tagSnapshot !== undefined) {
    const tagIds = video.tagSnapshot.map((tag) => tag.tagId.toString());
    const tagNames = video.tagSnapshot.map((tag) => tag.tagName);
    await pool.query(
      `INSERT INTO tags (tag_id, tag_name, updated_at)
       SELECT tag_id, tag_name, NOW()
       FROM unnest($1::bigint[], $2::text[]) AS snapshot(tag_id, tag_name)
       ON CONFLICT (tag_id) DO UPDATE SET
         tag_name = EXCLUDED.tag_name,
         updated_at = EXCLUDED.updated_at`,
      [tagIds, tagNames],
    );
    await pool.query(
      `DELETE FROM video_tags
       WHERE video_aid = $1::bigint`,
      [video.aid.toString()],
    );
    await pool.query(
      `INSERT INTO video_tags (video_aid, tag_id)
       SELECT $1::bigint, tag_id
       FROM unnest($2::bigint[]) AS snapshot(tag_id)
       ON CONFLICT (video_aid, tag_id) DO NOTHING`,
      [video.aid.toString(), tagIds],
    );
  }
}

export async function updateProcessedVideoPidV2(
  pool: DatabaseQuery,
  metadata: ReadonlyArray<{ aid: bigint; pidV2: number }>,
): Promise<number> {
  if (metadata.length === 0) return 0;
  const result = await pool.query(
    `WITH metadata(aid, pid_v2) AS (
       SELECT *
       FROM unnest($1::bigint[], $2::integer[])
     )
     UPDATE processed_videos AS video
     SET pid_v2 = metadata.pid_v2,
         updated_at = NOW()
     FROM metadata
     WHERE video.aid = metadata.aid
       AND video.aid = ANY($1::bigint[])
       AND video.pid_v2 IS DISTINCT FROM metadata.pid_v2`,
    [
      metadata.map((item) => item.aid.toString()),
      metadata.map((item) => item.pidV2),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Persist a processed video and its collection state atomically.
 */
export async function markVideoProcessedWithCollectionState(
  pool: Pool,
  video: VideoData,
  filtered: boolean,
  now = new Date(),
  options?: ProcessedVideoCollectionOptions,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await markVideoProcessed(client, video, filtered);
    await upsertCollectionStateFromProcessedVideo(
      client,
      {
        aid: video.aid,
        pubdate: video.pubdate,
        ctime: video.ctime,
        tidV2: video.tid_v2,
        isDeleted: video.is_deleted ?? false,
        isFiltered: filtered,
      },
      now,
      options,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
    pid_v2: row.pid_v2 as number | undefined,
    mission_id: row.mission_id ? BigInt(row.mission_id) : undefined,
    extras: row.extras ? row.extras : undefined,
    notes: row.notes ? row.notes : undefined,
  }));
}

function deletedVideoInsert(
  client: PoolClient,
  identity: VideoIdentity,
  notesJson: string | null,
) {
  if (identity.type === "aid") {
    return client.query<{ aid: string }>(
      `INSERT INTO processed_videos (aid, bvid, is_filtered, is_deleted, notes)
       VALUES ($1::bigint, av2bv($1::bigint), false, true, $2)
       ON CONFLICT (aid) DO UPDATE SET
         is_deleted = true,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING aid`,
      [identity.aid.toString(), notesJson],
    );
  }

  return client.query<{ aid: string }>(
    `INSERT INTO processed_videos (aid, bvid, is_filtered, is_deleted, notes)
     VALUES (bv2av($1), $1, false, true, $2)
     ON CONFLICT (bvid) DO UPDATE SET
       aid = bv2av(EXCLUDED.bvid),
       is_deleted = true,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING aid`,
    [identity.bvid, notesJson],
  );
}

/**
 * Mark an authoritatively unavailable video as deleted and terminally disable
 * any existing collection state in the same transaction.
 */
export async function markVideoDeleted(
  pool: Pool,
  identity: VideoIdentity,
  notes?: VideoDeletionNotes,
): Promise<bigint> {
  const notesJson = notes ? JSON.stringify(notes) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await deletedVideoInsert(client, identity, notesJson);
    const aid = BigInt(result.rows[0].aid);
    await client.query(
      `UPDATE video_collection_state
       SET priority = -1,
           next_minute_due_at = NULL,
           updated_at = NOW()
       WHERE aid = $1::bigint`,
      [aid.toString()],
    );
    await client.query("COMMIT");
    return aid;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get list of bvids only (lightweight, for batch processing)
 */
export async function getBvidList(
  pool: Pool,
  query: string | BvidListQuery = {},
): Promise<string[]> {
  const normalizedQuery = typeof query === "string" ? { where: query } : query;
  let sql = "SELECT bvid FROM processed_videos";
  if (normalizedQuery.where) {
    sql += ` WHERE ${normalizedQuery.where}`;
  }
  sql += " ORDER BY created_at DESC";
  if (normalizedQuery.limit !== undefined) {
    sql += ` LIMIT $${(normalizedQuery.params ?? []).length + 1}`;
  }

  const params =
    normalizedQuery.limit !== undefined
      ? [...(normalizedQuery.params ?? []), normalizedQuery.limit]
      : (normalizedQuery.params ?? []);

  const result = await pool.query(sql, params);
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
    `SELECT aid, bvid, recorded_at, title, description, tag, tag_new,
            pic, is_deleted, is_filtered, extras, notes
     FROM video_history
     WHERE bvid = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
    [bvid, limit],
  );

  return result.rows.map((row) => ({
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
