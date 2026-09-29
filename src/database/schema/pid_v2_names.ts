import type { Pool } from "pg";

export async function initPidV2NamesSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pid_v2_names (
      pid_v2 INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
}
