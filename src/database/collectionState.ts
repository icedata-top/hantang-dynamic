import type { Pool } from "pg";
import type { ProcessedVideoCollectionInput } from "../types/models/minute.js";

export async function refreshVideoCollectionStateFromDaily(
  pool: Pool,
  aids?: bigint[],
  now = new Date(),
): Promise<number> {
  const result = await pool.query(
    "SELECT fn_refresh_video_collection_state_from_daily($1::bigint[], $2) AS count",
    [aids?.map((aid) => aid.toString()) ?? null, now],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function upsertCollectionStateFromProcessedVideo(
  pool: Pool,
  input: ProcessedVideoCollectionInput,
  now = new Date(),
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
      $10::timestamptz
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
    ],
  );
  return String(result.rows[0]?.result ?? "unknown");
}
