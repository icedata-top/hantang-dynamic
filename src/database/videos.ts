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

export interface ProcessedVideoRecommendationRefresh {
  aid: bigint;
  bvid?: string;
  title?: string;
  description?: string;
  pic?: string;
  cover43?: string;
  typeId?: number;
  userId?: bigint;
  pubdate?: number;
  pidV2?: number;
}

export interface ProcessedVideoBatchItem {
  video: VideoData;
  filtered: boolean;
}

function canonicalTagSnapshot(
  tagSnapshot: VideoData["tagSnapshot"],
): Array<{ tagId: bigint; tagName: string }> | undefined {
  if (tagSnapshot === undefined) return undefined;

  const tagsById = new Map<bigint, string>();
  for (const tag of tagSnapshot) {
    if (!tagsById.has(tag.tagId)) tagsById.set(tag.tagId, tag.tagName);
  }
  return [...tagsById]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([tagId, tagName]) => ({ tagId, tagName }));
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
 * Return the subset of a bounded AID batch that is already processed.
 */
export async function getProcessedVideoAids(
  pool: Pool,
  aids: ReadonlyArray<bigint>,
): Promise<Set<bigint>> {
  const uniqueAids = [...new Set(aids.map((aid) => aid.toString()))];
  if (uniqueAids.length === 0) return new Set();

  const result = await pool.query(
    `SELECT aid
     FROM processed_videos
     WHERE aid = ANY($1::bigint[])`,
    [uniqueAids],
  );
  return new Set(result.rows.map((row) => BigInt(row.aid as string)));
}

/** Return the missing-pid subset of a bounded processed-video AID batch. */
export async function getProcessedVideoAidsMissingPidV2(
  pool: Pool,
  aids: ReadonlyArray<bigint>,
): Promise<Set<bigint>> {
  const uniqueAids = [...new Set(aids.map((aid) => aid.toString()))];
  if (uniqueAids.length === 0) return new Set();

  const result = await pool.query(
    `SELECT aid
     FROM processed_videos
     WHERE aid = ANY($1::bigint[])
       AND pid_v2 IS NULL`,
    [uniqueAids],
  );
  return new Set(result.rows.map((row) => BigInt(row.aid as string)));
}

/**
 * Refresh fields supplied by recommendation cards without changing review
 * state, detail-only fields, or authoritative TAG relations.
 */
export async function refreshProcessedVideosFromRecommendations(
  pool: DatabaseQuery,
  videos: ReadonlyArray<ProcessedVideoRecommendationRefresh>,
): Promise<number> {
  const byAid = new Map<bigint, ProcessedVideoRecommendationRefresh>();
  for (const video of videos) byAid.set(video.aid, video);
  const entries = [...byAid.values()];
  if (entries.length === 0) return 0;

  const result = await pool.query(
    `WITH incoming AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS input(
         aid bigint, bvid varchar, title varchar, description text, pic varchar,
         cover43 varchar, type_id integer, user_id bigint, pubdate bigint,
         pid_v2 integer
       )
     )
     UPDATE processed_videos AS video
     SET bvid = COALESCE(incoming.bvid, video.bvid),
         title = COALESCE(incoming.title, video.title),
         description = COALESCE(incoming.description, video.description),
         pic = COALESCE(incoming.pic, video.pic),
         cover43 = COALESCE(incoming.cover43, video.cover43),
         type_id = COALESCE(incoming.type_id, video.type_id),
         user_id = COALESCE(incoming.user_id, video.user_id),
         pubdate = COALESCE(incoming.pubdate, video.pubdate),
         pid_v2 = COALESCE(incoming.pid_v2, video.pid_v2),
         updated_at = NOW()
     FROM incoming
     WHERE video.aid = incoming.aid
       AND (
         video.bvid IS DISTINCT FROM COALESCE(incoming.bvid, video.bvid)
         OR video.title IS DISTINCT FROM COALESCE(incoming.title, video.title)
         OR video.description IS DISTINCT FROM COALESCE(incoming.description, video.description)
         OR video.pic IS DISTINCT FROM COALESCE(incoming.pic, video.pic)
         OR (incoming.cover43 IS NOT NULL
             AND video.cover43 IS DISTINCT FROM incoming.cover43)
         OR video.type_id IS DISTINCT FROM COALESCE(incoming.type_id, video.type_id)
         OR video.user_id IS DISTINCT FROM COALESCE(incoming.user_id, video.user_id)
         OR video.pubdate IS DISTINCT FROM COALESCE(incoming.pubdate, video.pubdate)
         OR (incoming.pid_v2 IS NOT NULL
             AND video.pid_v2 IS DISTINCT FROM incoming.pid_v2)
       )`,
    [
      JSON.stringify(
        entries.map((video) => ({
          aid: video.aid.toString(),
          ...(video.bvid === undefined ? {} : { bvid: video.bvid }),
          ...(video.title === undefined ? {} : { title: video.title }),
          ...(video.description === undefined
            ? {}
            : { description: video.description }),
          ...(video.pic === undefined ? {} : { pic: video.pic }),
          cover43:
            video.cover43 && video.cover43.length > 0 ? video.cover43 : null,
          ...(video.typeId === undefined ? {} : { type_id: video.typeId }),
          ...(video.userId === undefined
            ? {}
            : { user_id: video.userId.toString() }),
          ...(video.pubdate === undefined ? {} : { pubdate: video.pubdate }),
          ...(video.pidV2 === undefined ? {} : { pid_v2: video.pidV2 }),
        })),
      ),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Mark a video as processed
 */
export async function markVideoProcessed(
  pool: DatabaseQuery,
  video: VideoData,
  filtered: boolean,
): Promise<void> {
  const tagSnapshot = canonicalTagSnapshot(video.tagSnapshot);
  await pool.query(
    `
    INSERT INTO processed_videos 
      (aid, bvid, pubdate, title, description, tag, pic, type_id, user_id, is_filtered, 
       staff, tid_v2, dynamic, tag_new, participle, ctime, is_deleted, copyright,
       pid_v2, mission_id, extras, notes, cover43, tag_ids, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW())
    ON CONFLICT (bvid) DO UPDATE SET
      aid = EXCLUDED.aid,
      pubdate = EXCLUDED.pubdate,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tag = CASE
        WHEN $25::boolean THEN EXCLUDED.tag
        ELSE processed_videos.tag
      END,
      pic = EXCLUDED.pic,
      cover43 = COALESCE(EXCLUDED.cover43, processed_videos.cover43),
      type_id = EXCLUDED.type_id,
      user_id = EXCLUDED.user_id,
      is_filtered = EXCLUDED.is_filtered,
      staff = EXCLUDED.staff,
      tid_v2 = EXCLUDED.tid_v2,
      dynamic = EXCLUDED.dynamic,
      tag_new = CASE
        WHEN $25::boolean THEN EXCLUDED.tag_new
        ELSE processed_videos.tag_new
      END,
      tag_ids = CASE
        WHEN $25::boolean THEN EXCLUDED.tag_ids
        ELSE processed_videos.tag_ids
      END,
      participle = EXCLUDED.participle,
      ctime = EXCLUDED.ctime,
      is_deleted = EXCLUDED.is_deleted,
      copyright = EXCLUDED.copyright,
      pid_v2 = COALESCE(EXCLUDED.pid_v2, processed_videos.pid_v2),
      mission_id = COALESCE(EXCLUDED.mission_id, processed_videos.mission_id),
      extras = EXCLUDED.extras,
      notes = COALESCE(EXCLUDED.notes, processed_videos.notes),
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
      video.cover43 && video.cover43.length > 0 ? video.cover43 : null,
      tagSnapshot?.map((tag) => tag.tagId.toString()) ?? null,
      tagSnapshot !== undefined,
    ],
  );

  if (tagSnapshot !== undefined) {
    const tagIds = tagSnapshot.map((tag) => tag.tagId.toString());
    const tagNames = tagSnapshot.map((tag) => tag.tagName);
    await pool.query(
      `INSERT INTO tags (tag_id, tag_name, updated_at)
       SELECT tag_id, tag_name, NOW()
       FROM unnest($1::bigint[], $2::text[]) AS snapshot(tag_id, tag_name)
       ON CONFLICT (tag_id) DO UPDATE SET
         tag_name = EXCLUDED.tag_name,
         updated_at = EXCLUDED.updated_at`,
      [tagIds, tagNames],
    );
  }
}

function batchVideoRow(item: ProcessedVideoBatchItem) {
  const { video } = item;
  const tagSnapshot = canonicalTagSnapshot(video.tagSnapshot);
  return {
    aid: video.aid.toString(),
    bvid: video.bvid,
    pubdate: video.pubdate,
    title: video.title,
    description: video.description,
    tag: tagSnapshot === undefined ? null : video.tag,
    pic: video.pic,
    type_id: video.type_id,
    user_id: video.user_id.toString(),
    is_filtered: item.filtered,
    staff: video.staff?.map((staff) => staff.toString()) ?? null,
    tid_v2: video.tid_v2 ?? null,
    dynamic: video.dynamic ?? null,
    tag_new: tagSnapshot === undefined ? null : (video.tag_new ?? null),
    tag_ids: tagSnapshot?.map((tag) => tag.tagId.toString()) ?? null,
    tag_snapshot:
      tagSnapshot === undefined
        ? null
        : tagSnapshot.map((tag) => ({
            tagId: tag.tagId.toString(),
            tagName: tag.tagName,
          })),
    participle: video.participle ?? null,
    ctime: video.ctime ?? null,
    is_deleted: video.is_deleted ?? false,
    copyright: video.copyright ?? null,
    pid_v2: video.pid_v2 ?? null,
    mission_id: video.mission_id?.toString() ?? null,
    extras: video.extras ?? null,
    notes: video.notes ?? null,
    cover43: video.cover43 && video.cover43.length > 0 ? video.cover43 : null,
  };
}

/**
 * Persist a bounded set of full-detail videos and their collection state in a
 * single transaction. TAG snapshots are authoritative only when supplied.
 */
export async function markVideosProcessedWithCollectionState(
  pool: Pool,
  items: ReadonlyArray<ProcessedVideoBatchItem>,
  now = new Date(),
  options?: ProcessedVideoCollectionOptions,
): Promise<number> {
  const byAid = new Map<bigint, ProcessedVideoBatchItem>();
  for (const item of items) byAid.set(item.video.aid, item);
  const rows = [...byAid.values()].map(batchVideoRow);
  if (rows.length === 0) return 0;

  const payload = JSON.stringify(rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const written = await client.query(
      `WITH incoming AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS input(
           aid bigint, bvid varchar, pubdate bigint, title varchar,
           description text, tag text, pic varchar, type_id integer,
           user_id bigint, is_filtered boolean, staff bigint[], tid_v2 integer,
           dynamic text, tag_new varchar[], tag_ids bigint[], tag_snapshot jsonb,
           participle varchar[], ctime bigint, is_deleted boolean, copyright integer,
           pid_v2 integer, mission_id bigint, extras jsonb, notes jsonb, cover43 varchar
         )
       )
       INSERT INTO processed_videos AS video (
         aid, bvid, pubdate, title, description, tag, pic, type_id, user_id,
         is_filtered, staff, tid_v2, dynamic, tag_new, tag_ids, participle,
         ctime, is_deleted, copyright, pid_v2, mission_id, extras, notes, cover43,
         updated_at
       )
       SELECT aid, bvid, pubdate, title, description, tag, pic, type_id, user_id,
              is_filtered, staff, tid_v2, dynamic, tag_new, tag_ids, participle,
              ctime, is_deleted, copyright, pid_v2, mission_id, extras, notes, cover43,
              NOW()
       FROM incoming
       ON CONFLICT (aid) DO UPDATE SET
         bvid = EXCLUDED.bvid,
         pubdate = EXCLUDED.pubdate,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         tag = COALESCE(EXCLUDED.tag, video.tag),
         pic = EXCLUDED.pic,
         cover43 = COALESCE(EXCLUDED.cover43, video.cover43),
         type_id = EXCLUDED.type_id,
         user_id = EXCLUDED.user_id,
         is_filtered = EXCLUDED.is_filtered,
         staff = EXCLUDED.staff,
         tid_v2 = EXCLUDED.tid_v2,
         dynamic = EXCLUDED.dynamic,
         tag_new = COALESCE(EXCLUDED.tag_new, video.tag_new),
         tag_ids = COALESCE(EXCLUDED.tag_ids, video.tag_ids),
         participle = EXCLUDED.participle,
         ctime = EXCLUDED.ctime,
         is_deleted = EXCLUDED.is_deleted,
         copyright = EXCLUDED.copyright,
         pid_v2 = COALESCE(EXCLUDED.pid_v2, video.pid_v2),
         mission_id = COALESCE(EXCLUDED.mission_id, video.mission_id),
         extras = EXCLUDED.extras,
         notes = COALESCE(EXCLUDED.notes, video.notes),
         updated_at = NOW()
       WHERE video.bvid IS DISTINCT FROM EXCLUDED.bvid
          OR video.pubdate IS DISTINCT FROM EXCLUDED.pubdate
          OR video.title IS DISTINCT FROM EXCLUDED.title
          OR video.description IS DISTINCT FROM EXCLUDED.description
          OR (EXCLUDED.tag IS NOT NULL AND video.tag IS DISTINCT FROM EXCLUDED.tag)
          OR video.pic IS DISTINCT FROM EXCLUDED.pic
          OR (EXCLUDED.cover43 IS NOT NULL AND video.cover43 IS DISTINCT FROM EXCLUDED.cover43)
          OR video.type_id IS DISTINCT FROM EXCLUDED.type_id
          OR video.user_id IS DISTINCT FROM EXCLUDED.user_id
          OR video.is_filtered IS DISTINCT FROM EXCLUDED.is_filtered
          OR video.staff IS DISTINCT FROM EXCLUDED.staff
          OR video.tid_v2 IS DISTINCT FROM EXCLUDED.tid_v2
          OR video.dynamic IS DISTINCT FROM EXCLUDED.dynamic
          OR (EXCLUDED.tag_new IS NOT NULL AND video.tag_new IS DISTINCT FROM EXCLUDED.tag_new)
          OR (EXCLUDED.tag_ids IS NOT NULL AND video.tag_ids IS DISTINCT FROM EXCLUDED.tag_ids)
          OR video.participle IS DISTINCT FROM EXCLUDED.participle
          OR video.ctime IS DISTINCT FROM EXCLUDED.ctime
          OR video.is_deleted IS DISTINCT FROM EXCLUDED.is_deleted
          OR video.copyright IS DISTINCT FROM EXCLUDED.copyright
          OR (EXCLUDED.pid_v2 IS NOT NULL AND video.pid_v2 IS DISTINCT FROM EXCLUDED.pid_v2)
          OR (EXCLUDED.mission_id IS NOT NULL AND video.mission_id IS DISTINCT FROM EXCLUDED.mission_id)
          OR video.extras IS DISTINCT FROM EXCLUDED.extras
          OR (EXCLUDED.notes IS NOT NULL AND video.notes IS DISTINCT FROM EXCLUDED.notes)
       RETURNING aid`,
      [payload],
    );
    await client.query(
      `WITH incoming AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS input(aid bigint, tag_snapshot jsonb)
       ), tags_to_upsert AS (
         SELECT DISTINCT ON ((tag->>'tagId')::bigint)
           (tag->>'tagId')::bigint AS tag_id,
           tag->>'tagName' AS tag_name
         FROM incoming
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tag_snapshot, '[]'::jsonb)) AS tag
         ORDER BY (tag->>'tagId')::bigint, tag->>'tagName'
       )
       INSERT INTO tags (tag_id, tag_name, updated_at)
       SELECT tag_id, tag_name, NOW()
       FROM tags_to_upsert
       ON CONFLICT (tag_id) DO UPDATE SET
         tag_name = EXCLUDED.tag_name,
         updated_at = EXCLUDED.updated_at`,
      [payload],
    );
    await client.query(
      `SELECT fn_upsert_collection_state_from_processed_video(
         input.aid, input.pubdate, input.ctime, input.tid_v2,
         NULL, NULL, NULL, input.is_deleted, input.is_filtered,
         $2::timestamptz, $3::integer, $4::integer, $5::text[], $6::text,
         $7::text[], $8::integer[], $9::integer
       )
       FROM jsonb_to_recordset($1::jsonb) AS input(
         aid bigint, pubdate bigint, ctime bigint, tid_v2 integer,
         is_deleted boolean, is_filtered boolean
       )`,
      [
        payload,
        now,
        options?.bootstrapPriority ?? 10,
        options?.bootstrapTtlHours ?? 24,
        options?.bootstrapLabelContentTypes ?? ["vocaloid", "maybe_vocaloid"],
        options?.bootstrapLabelOrigin ?? "rule",
        options?.bootstrapLabelWriters ?? [
          "classification_apply",
          "classification_trigger",
        ],
        options?.bootstrapTidV2Allowlist ?? [2022, 2061],
        options?.processedBackfillNewVideoAgeDays ?? 7,
      ],
    );
    await client.query("COMMIT");
    return written.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ProcessedVideoMetadata {
  aid: bigint;
  pidV2?: number;
  cover43?: string;
}

export interface ProcessedVideoMetadataCandidate {
  aid: bigint;
  bvid: string;
  pidV2?: number;
}

export interface ProcessedVideoMetadataSweep {
  afterAid: bigint;
  createdBefore: Date;
  onlyMissingPidV2?: boolean;
  throughAid: bigint;
  limit: number;
}

/** Return the upper AID boundary for one manually started metadata sweep. */
export async function getProcessedVideoMetadataUpperAid(
  pool: Pool,
): Promise<bigint | null> {
  const result = await pool.query(
    "SELECT MAX(aid) AS aid FROM processed_videos",
  );
  const aid = result.rows[0]?.aid;
  return aid === null || aid === undefined ? null : BigInt(aid);
}

/**
 * Read one immutable-at-start page of processed videos in AID order.  The
 * creation cutoff prevents videos imported by the updater from becoming part
 * of its own source sweep.
 */
export async function getProcessedVideoMetadataCandidates(
  pool: Pool,
  options: ProcessedVideoMetadataSweep,
): Promise<ProcessedVideoMetadataCandidate[]> {
  const result = await pool.query(
    `SELECT aid, bvid, pid_v2
     FROM processed_videos
     WHERE aid > $1::bigint
       AND aid <= $2::bigint
       AND created_at <= $3::timestamptz
       AND ($4::boolean = false OR pid_v2 IS NULL)
     ORDER BY aid ASC
     LIMIT $5`,
    [
      options.afterAid.toString(),
      options.throughAid.toString(),
      options.createdBefore,
      options.onlyMissingPidV2 ?? false,
      options.limit,
    ],
  );
  return result.rows.map((row) => ({
    aid: BigInt(row.aid),
    bvid: row.bvid as string,
    ...(typeof row.pid_v2 === "number" ? { pidV2: row.pid_v2 } : {}),
  }));
}

/**
 * Update supplemental metadata for existing processed videos in one set-based query.
 */
export async function updateProcessedVideoMetadata(
  pool: DatabaseQuery,
  metadata: ReadonlyArray<ProcessedVideoMetadata>,
): Promise<number> {
  const byAid = new Map<bigint, ProcessedVideoMetadata>();
  for (const item of metadata) {
    const existing = byAid.get(item.aid);
    byAid.set(item.aid, {
      aid: item.aid,
      ...(existing?.pidV2 !== undefined ? { pidV2: existing.pidV2 } : {}),
      ...(existing?.cover43 !== undefined ? { cover43: existing.cover43 } : {}),
      ...(item.pidV2 !== undefined ? { pidV2: item.pidV2 } : {}),
      ...(item.cover43 !== undefined && item.cover43.length > 0
        ? { cover43: item.cover43 }
        : {}),
    });
  }

  const entries = [...byAid.values()].filter(
    (item) => item.pidV2 !== undefined || item.cover43 !== undefined,
  );
  if (entries.length === 0) return 0;

  const result = await pool.query(
    `WITH metadata(aid, pid_v2, cover43) AS (
       SELECT *
       FROM unnest($1::bigint[], $2::integer[], $3::varchar[])
     )
     UPDATE processed_videos AS video
     SET pid_v2 = COALESCE(metadata.pid_v2, video.pid_v2),
         cover43 = COALESCE(metadata.cover43, video.cover43),
         updated_at = NOW()
     FROM metadata
     WHERE video.aid = metadata.aid
       AND video.aid = ANY($1::bigint[])
       AND (
         metadata.pid_v2 IS NOT NULL
         AND video.pid_v2 IS DISTINCT FROM metadata.pid_v2
         OR metadata.cover43 IS NOT NULL
         AND video.cover43 IS DISTINCT FROM metadata.cover43
       )`,
    [
      entries.map((item) => item.aid.toString()),
      entries.map((item) => item.pidV2 ?? null),
      entries.map((item) => item.cover43 ?? null),
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
    cover43: row.cover43 as string | undefined,
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
    const existingAid =
      identity.type === "bvid"
        ? await client.query<{ aid: string }>(
            `SELECT aid
             FROM processed_videos
             WHERE bvid = $1
             FOR UPDATE`,
            [identity.bvid],
          )
        : undefined;
    const result = await deletedVideoInsert(client, identity, notesJson);
    const aid = BigInt(result.rows[0].aid);
    const terminalAids = [
      ...new Set([
        ...(existingAid?.rows.map((row) => row.aid) ?? []),
        aid.toString(),
      ]),
    ];
    await client.query(
      `UPDATE video_collection_state
       SET priority = -1,
           next_minute_due_at = NULL,
           updated_at = NOW()
       WHERE aid = ANY($1::bigint[])`,
      [terminalAids],
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
    `SELECT aid, bvid, recorded_at, title, description, tag, tag_new, tag_ids,
            pic, cover43, is_deleted, is_filtered, extras, notes
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
    tagIds: Array.isArray(row.tag_ids)
      ? (row.tag_ids as Array<string | number>).map((tagId) => BigInt(tagId))
      : null,
    pic: row.pic as string | null,
    cover43: row.cover43 as string | null,
    isDeleted: row.is_deleted as boolean | null,
    isFiltered: row.is_filtered as boolean | null,
    extras: row.extras as Record<string, unknown> | null,
    notes: row.notes as Record<string, unknown> | null,
  }));
}
