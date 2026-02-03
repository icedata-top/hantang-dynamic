import type { Pool } from "pg";

/**
 * Get cached forward dynamic BVID
 */
export async function getCachedForwardBvid(
  pool: Pool,
  dynamicId: string,
): Promise<string | null> {
  const result = await pool.query(
    "SELECT original_bvid FROM forward_dynamics WHERE forward_dynamic_id = $1",
    [dynamicId],
  );

  return result.rows.length > 0
    ? (result.rows[0]?.original_bvid as string)
    : null;
}

/**
 * Cache forward dynamic relationship
 */
export async function cacheForward(
  pool: Pool,
  dynamicId: string,
  bvid: string,
): Promise<void> {
  await pool.query(
    `
    INSERT INTO forward_dynamics 
      (forward_dynamic_id, original_bvid)
    VALUES ($1, $2)
    ON CONFLICT (forward_dynamic_id) DO UPDATE SET
      original_bvid = EXCLUDED.original_bvid
  `,
    [dynamicId, bvid],
  );
}
