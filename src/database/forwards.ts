import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Get cached forward dynamic BVID
 */
export async function getCachedForwardBvid(
  connection: DuckDBConnection,
  dynamicId: string,
): Promise<string | null> {
  const reader = await connection.runAndReadAll(
    "SELECT original_bvid FROM forward_dynamics WHERE forward_dynamic_id = $1",
    { 1: BigInt(dynamicId) },
  );

  const rows = reader.getRows();
  return rows.length > 0 ? (rows[0]?.[0] as string) : null;
}

/**
 * Cache forward dynamic relationship
 */
export async function cacheForward(
  connection: DuckDBConnection,
  dynamicId: string,
  bvid: string,
): Promise<void> {
  await connection.run(
    `
    INSERT INTO forward_dynamics 
      (forward_dynamic_id, original_bvid)
    VALUES ($1, $2)
    ON CONFLICT (forward_dynamic_id) DO UPDATE SET
      original_bvid = EXCLUDED.original_bvid
  `,
    {
      1: BigInt(dynamicId),
      2: bvid,
    },
  );
}
