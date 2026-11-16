import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

export const COLLECTION_WHITELIST_KINDS = [
  "tid_v1",
  "tid_v2",
  "pid_v2",
] as const;
export type CollectionWhitelistKind =
  (typeof COLLECTION_WHITELIST_KINDS)[number];

/**
 * Create the database-resident whitelist that decides which videos are
 * monitored (and which related videos are admitted).
 *
 * A video qualifies when its tid_v2 is listed under kind 'tid_v2' or its
 * pid_v2 is listed under kind 'pid_v2'. Kind 'tid_v1' lists legacy type_id
 * values. They are always present but less reliable, so they only decide while
 * a video has neither tid_v2 nor pid_v2; once either arrives, v2 is
 * authoritative and a v1 match no longer counts. The table is the single source
 * of truth: edit it with plain SQL, then run fn_reevaluate_collection_whitelist()
 * to apply the change to videos that are already stored.
 *
 * The TOML/env values (`whitelist.video.type_ids`,
 * `whitelist.minute_bootstrap.tid_v2`, `whitelist.recommendation.pid_v2`) are
 * read only once, to seed the table the first time it is created. Later changes
 * to those keys have no effect.
 */
export async function initCollectionWhitelistSchema(pool: Pool): Promise<void> {
  const existing = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('collection_whitelist') IS NOT NULL AS present",
  );
  const alreadyCreated = existing.rows[0]?.present === true;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collection_whitelist (
      kind text NOT NULL,
      value integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, value),
      CONSTRAINT chk_collection_whitelist_kind
        CHECK (kind IN ('tid_v1', 'tid_v2', 'pid_v2'))
    )
  `);

  // The constraint above only applies to a brand-new table; widen older ones.
  await pool.query(`
    ALTER TABLE collection_whitelist
    DROP CONSTRAINT IF EXISTS chk_collection_whitelist_kind
  `);
  await pool.query(`
    ALTER TABLE collection_whitelist
    ADD CONSTRAINT chk_collection_whitelist_kind
      CHECK (kind IN ('tid_v1', 'tid_v2', 'pid_v2'))
  `);

  if (!alreadyCreated) {
    const seeds: Array<[CollectionWhitelistKind, number]> = [
      ...config.whitelist.video.typeIds.map(
        (value): [CollectionWhitelistKind, number] => ["tid_v1", value],
      ),
      ...config.whitelist.minuteBootstrap.tidV2.map(
        (value): [CollectionWhitelistKind, number] => ["tid_v2", value],
      ),
      ...config.whitelist.recommendation.pidV2.map(
        (value): [CollectionWhitelistKind, number] => ["pid_v2", value],
      ),
    ];
    for (const [kind, value] of seeds) {
      await pool.query(
        `INSERT INTO collection_whitelist (kind, value)
         VALUES ($1, $2)
         ON CONFLICT (kind, value) DO NOTHING`,
        [kind, value],
      );
    }
    logger.info(
      `collection_whitelist: created and seeded with ${seeds.length} value(s) from config`,
    );
  }

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_collection_whitelist_match(
      p_tid_v2 integer,
      p_pid_v2 integer
    ) RETURNS boolean AS $$
      SELECT EXISTS (
        SELECT 1
        FROM collection_whitelist
        WHERE (kind = 'tid_v2' AND value = p_tid_v2)
           OR (kind = 'pid_v2' AND value = p_pid_v2)
      )
    $$ LANGUAGE sql STABLE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_collection_whitelist_match_v1(
      p_type_id integer
    ) RETURNS boolean AS $$
      SELECT EXISTS (
        SELECT 1
        FROM collection_whitelist
        WHERE kind = 'tid_v1' AND value = p_type_id
      )
    $$ LANGUAGE sql STABLE
  `);
}
