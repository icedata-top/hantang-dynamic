import type { Pool } from "pg";
import type { DynamicData } from "../types/models/database.js";

/**
 * Save a dynamic to the database.
 * For type=1 (forward), the `bvid` field also serves as the forward→bvid cache,
 * For type=1 (forward), the `bvid` field also serves as the forward→bvid cache.
 * On conflict, fills in any previously NULL fields without overwriting existing data.
 */
export async function saveDynamic(
  pool: Pool,
  data: DynamicData,
): Promise<void> {
  await pool.query(
    `INSERT INTO dynamics
       (dynamic_id, user_id, type, timestamp, bvid, orig_dynamic_id, orig_type,
        text_content, forward_text, images, card, extend_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (dynamic_id) DO UPDATE SET
       bvid        = COALESCE(EXCLUDED.bvid,         dynamics.bvid),
       text_content = COALESCE(EXCLUDED.text_content, dynamics.text_content),
       forward_text = COALESCE(EXCLUDED.forward_text, dynamics.forward_text),
       images      = COALESCE(EXCLUDED.images,        dynamics.images),
       card        = COALESCE(EXCLUDED.card,          dynamics.card),
       extend_json = COALESCE(EXCLUDED.extend_json,   dynamics.extend_json)`,
    [
      data.dynamicId.toString(),
      data.userId.toString(),
      data.type,
      data.timestamp,
      data.bvid ?? null,
      data.origDynamicId?.toString() ?? null,
      data.origType ?? null,
      data.textContent ?? null,
      data.forwardText ?? null,
      data.images ? JSON.stringify(data.images) : null,
      data.card ? JSON.stringify(data.card) : null,
      data.extendJson ? JSON.stringify(data.extendJson) : null,
    ],
  );
}

/**
 * Get the resolved original video BVID for a forward dynamic.
 */
export async function getCachedForwardBvid(
  pool: Pool,
  dynamicId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT bvid FROM dynamics
     WHERE dynamic_id = $1 AND type = 1 AND bvid IS NOT NULL`,
    [dynamicId],
  );
  return (result.rows[0]?.bvid as string) ?? null;
}
