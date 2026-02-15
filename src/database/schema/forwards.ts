import type { Pool } from "pg";

export async function initForwardsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forward_dynamics (
      forward_dynamic_id BIGINT PRIMARY KEY,
      original_bvid VARCHAR NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_forward_bvid
    ON forward_dynamics(original_bvid)
  `);
}
