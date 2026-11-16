import type { Pool } from "pg";
import type { CollectionWhitelistKind } from "./schema/collection_whitelist.js";

/** Read one list from the database-resident collection whitelist. */
export async function getCollectionWhitelist(
  pool: Pool,
  kind: CollectionWhitelistKind,
): Promise<number[]> {
  const result = await pool.query<{ value: number }>(
    "SELECT value FROM collection_whitelist WHERE kind = $1 ORDER BY value",
    [kind],
  );
  return result.rows.map((row) => Number(row.value));
}
