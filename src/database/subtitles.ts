import type { Pool } from "pg";
import type {
  BiliSubtitleLine,
  BiliSubtitleStyle,
  SubtitleState,
  VideoSubtitleRow,
} from "../types/bilibili/subtitle.js";

export interface SubtitleJob {
  aid: bigint;
  bvid: string | null;
  lastView: bigint | null;
  isDeleted: boolean;
}

export interface UpsertSubtitleInput {
  aid: bigint;
  cid: bigint;
  lan: string;
  lanDoc: string | null;
  subtitleType: number | null;
  aiType: number | null;
  aiStatus: number | null;
  body: BiliSubtitleLine[];
  style: BiliSubtitleStyle | null;
}

function mapSubtitleRow(row: Record<string, unknown>): VideoSubtitleRow {
  return {
    aid: BigInt(row.aid as string | number),
    cid: BigInt(row.cid as string | number),
    lan: row.lan as string,
    lanDoc: (row.lan_doc as string | null) ?? null,
    subtitleType: (row.subtitle_type as number | null) ?? null,
    aiType: (row.ai_type as number | null) ?? null,
    aiStatus: (row.ai_status as number | null) ?? null,
    body: row.body as BiliSubtitleLine[],
    plainText: (row.plain_text as string | null) ?? null,
    lineCount: (row.line_count as number | null) ?? null,
    style: (row.style as BiliSubtitleStyle | null) ?? null,
    fetchedAt: new Date(row.fetched_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function subtitleInputParams(input: UpsertSubtitleInput): unknown[] {
  return [
    input.aid.toString(),
    input.cid.toString(),
    input.lan,
    input.lanDoc,
    input.subtitleType,
    input.aiType,
    input.aiStatus,
    JSON.stringify(input.body),
    input.body.map((line) => line.content).join("\n"),
    input.body.length,
    input.style ? JSON.stringify(input.style) : null,
  ];
}

const UPSERT_SUBTITLE_SQL = `
  INSERT INTO video_subtitles (
    aid, cid, lan, lan_doc, subtitle_type, ai_type, ai_status,
    body, plain_text, line_count, style, fetched_at, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
  ON CONFLICT (aid, cid, lan) DO UPDATE SET
    lan_doc       = EXCLUDED.lan_doc,
    subtitle_type = EXCLUDED.subtitle_type,
    ai_type       = EXCLUDED.ai_type,
    ai_status     = EXCLUDED.ai_status,
    body          = EXCLUDED.body,
    plain_text    = EXCLUDED.plain_text,
    line_count    = EXCLUDED.line_count,
    style         = EXCLUDED.style,
    updated_at    = now()
`;

export async function upsertSubtitlesBatch(
  pool: Pool,
  inputs: UpsertSubtitleInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const input of inputs) {
      await client.query(UPSERT_SUBTITLE_SQL, subtitleInputParams(input));
    }
    await client.query("COMMIT");
    return inputs.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSubtitleState(
  pool: Pool,
  aid: bigint,
  state: SubtitleState,
): Promise<void> {
  await pool.query(
    `UPDATE video_collection_state
     SET subtitle_state = $1,
         subtitle_failure_count = 0,
         last_subtitle_error_at = NULL,
         subtitle_last_error = NULL,
         updated_at = now()
     WHERE aid = $2`,
    [state, aid.toString()],
  );
}

export async function recordSubtitleFailure(
  pool: Pool,
  aid: bigint,
  errorMessage: string,
  maxRetries: number,
): Promise<{ state: SubtitleState | null; failureCount: number }> {
  const result = await pool.query<{
    subtitle_state: SubtitleState | null;
    subtitle_failure_count: number;
  }>(
    `UPDATE video_collection_state
     SET subtitle_failure_count = subtitle_failure_count + 1,
         last_subtitle_error_at = now(),
         subtitle_last_error = left($2, 500),
         subtitle_state = CASE
           WHEN subtitle_failure_count + 1 >= $3 THEN 'skipped'
           ELSE subtitle_state
         END,
         updated_at = now()
     WHERE aid = $1
     RETURNING subtitle_state, subtitle_failure_count`,
    [aid.toString(), errorMessage, maxRetries],
  );

  const row = result.rows[0];
  return {
    state: row?.subtitle_state ?? null,
    failureCount: Number(row?.subtitle_failure_count ?? 0),
  };
}

export async function selectNextSubtitleJob(
  pool: Pool,
): Promise<SubtitleJob | null> {
  const result = await pool.query<{
    aid: string;
    bvid: string | null;
    last_view: string | null;
    is_deleted: boolean | null;
  }>(
    `SELECT s.aid, p.bvid, s.last_view, p.is_deleted
     FROM video_collection_state s
     LEFT JOIN processed_videos p ON p.aid = s.aid
     WHERE s.subtitle_state = 'pending'
     ORDER BY s.last_view DESC NULLS LAST, s.aid ASC
     LIMIT 1`,
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    aid: BigInt(row.aid),
    bvid: row.bvid,
    lastView: row.last_view === null ? null : BigInt(row.last_view),
    isDeleted: row.is_deleted === true,
  };
}

export async function getSubtitlesByAid(
  pool: Pool,
  aid: bigint,
): Promise<VideoSubtitleRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM video_subtitles
     WHERE aid = $1
     ORDER BY cid ASC, lan ASC`,
    [aid.toString()],
  );
  return result.rows.map(mapSubtitleRow);
}

export async function getSubtitlesByCid(
  pool: Pool,
  aid: bigint,
  cid: bigint,
): Promise<VideoSubtitleRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM video_subtitles
     WHERE aid = $1 AND cid = $2
     ORDER BY lan ASC`,
    [aid.toString(), cid.toString()],
  );
  return result.rows.map(mapSubtitleRow);
}

export async function cidHasManualSubtitle(
  pool: Pool,
  aid: bigint,
  cid: bigint,
): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM video_subtitles
       WHERE aid = $1 AND cid = $2 AND ai_type = 0
     ) AS found`,
    [aid.toString(), cid.toString()],
  );
  return result.rows[0]?.found === true;
}

export async function aidHasManualSubtitle(
  pool: Pool,
  aid: bigint,
): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM video_subtitles
       WHERE aid = $1 AND ai_type = 0
     ) AS found`,
    [aid.toString()],
  );
  return result.rows[0]?.found === true;
}
