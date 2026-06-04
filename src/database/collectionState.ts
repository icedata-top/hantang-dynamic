import type { Pool } from "pg";
import type { ProcessedVideoCollectionInput } from "../types/models/minute.js";

export async function refreshVideoCollectionStateFromDaily(
  pool: Pool,
  aids?: bigint[],
  now = new Date(),
  options?: {
    targetDeltaPerSample?: number;
    targetDeltaLower?: number;
    targetDeltaUpper?: number;
    minPositivePriority?: number;
    maxPositivePriority?: number;
    businessTimezone?: string;
  },
): Promise<number> {
  const result = await pool.query(
    `
    SELECT fn_refresh_video_collection_state_from_daily(
      $1::bigint[],
      $2::timestamptz,
      $3::integer,
      $4::integer,
      $5::integer,
      $6::integer,
      $7::integer,
      $8::text
    ) AS count
  `,
    [
      aids?.map((aid) => aid.toString()) ?? null,
      now,
      options?.targetDeltaPerSample ?? 100,
      options?.targetDeltaLower ?? 50,
      options?.targetDeltaUpper ?? 200,
      options?.minPositivePriority ?? 1,
      options?.maxPositivePriority ?? 720,
      options?.businessTimezone ?? "Asia/Shanghai",
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function upsertCollectionStateFromProcessedVideo(
  pool: Pool,
  input: ProcessedVideoCollectionInput,
  now = new Date(),
  options?: {
    bootstrapPriority?: number;
    bootstrapTtlHours?: number;
    bootstrapLabelContentTypes?: string[];
    bootstrapLabelOrigin?: string;
    bootstrapLabelWriters?: string[];
    bootstrapTidV2Allowlist?: number[];
    processedBackfillNewVideoAgeDays?: number;
  },
): Promise<string> {
  const result = await pool.query(
    `
    SELECT fn_upsert_collection_state_from_processed_video(
      $1::bigint,
      $2::bigint,
      $3::bigint,
      $4::integer,
      $5::text,
      $6::text,
      $7::text,
      $8::boolean,
      $9::boolean,
      $10::timestamptz,
      $11::integer,
      $12::integer,
      $13::text[],
      $14::text,
      $15::text[],
      $16::integer[],
      $17::integer
    ) AS result
  `,
    [
      input.aid.toString(),
      input.pubdate ?? null,
      input.ctime ?? null,
      input.tidV2 ?? null,
      input.labelContentType ?? null,
      input.labelOrigin ?? null,
      input.labeledBy ?? null,
      input.isDeleted ?? false,
      input.isFiltered ?? null,
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
  return String(result.rows[0]?.result ?? "unknown");
}

export async function getNextMinuteDueAt(
  pool: Pool,
): Promise<Date | null> {
  const result = await pool.query(
    "SELECT fn_next_minute_due_at() AS due",
  );
  const due = result.rows[0]?.due;
  return due ? new Date(due) : null;
}

export async function selectDueMinuteVideos(
  pool: Pool,
  limit = 50,
  now = new Date(),
): Promise<{ aid: bigint; lastView: bigint | null }[]> {
  const result = await pool.query(
    "SELECT aid, last_view FROM fn_select_due_minute_videos($1, $2)",
    [now, limit],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    aid: BigInt(row.aid as string | number),
    lastView:
      row.last_view === null || row.last_view === undefined
        ? null
        : BigInt(row.last_view as string | number),
  }));
}

export async function advanceUnchangedMinuteVideos(
  pool: Pool,
  aids: bigint[],
  now = new Date(),
): Promise<number> {
  if (aids.length === 0) return 0;
  const result = await pool.query(
    "SELECT fn_advance_unchanged_minute_videos($1::bigint[], $2) AS count",
    [aids.map((a) => a.toString()), now],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function advanceFailedMinuteVideos(
  pool: Pool,
  aids: bigint[],
  now = new Date(),
): Promise<number> {
  if (aids.length === 0) return 0;
  const result = await pool.query(
    "SELECT fn_advance_failed_minute_videos($1::bigint[], $2) AS count",
    [aids.map((a) => a.toString()), now],
  );
  return Number(result.rows[0]?.count ?? 0);
}
