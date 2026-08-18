import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

/**
 * Upgrade the watch-later relations needed by minute sampling on every start.
 * The table and column statements deliberately precede dependent indexes.
 */
export async function initWatchLaterSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE video_collection_state
    ADD COLUMN IF NOT EXISTS watch_later_managed_account_ids bigint[] NOT NULL DEFAULT '{}'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_later_account (
      account_id bigint PRIMARY KEY,
      target_count integer NOT NULL DEFAULT 3000,
      configured_capacity integer NOT NULL DEFAULT 0,
      remote_capacity integer,
      lease_token uuid,
      lease_expires_at timestamptz,
      capacity_blocked_at timestamptz,
      last_complete_snapshot_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_watch_later_account_target_count CHECK (target_count > 0),
      CONSTRAINT chk_watch_later_account_configured_capacity CHECK (configured_capacity >= 0),
      CONSTRAINT chk_watch_later_account_remote_capacity
        CHECK (remote_capacity IS NULL OR remote_capacity > 0)
    )
  `);

  await pool.query(`
    ALTER TABLE watch_later_account
    ADD COLUMN IF NOT EXISTS target_count integer NOT NULL DEFAULT 3000,
    ADD COLUMN IF NOT EXISTS configured_capacity integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS remote_capacity integer,
    ADD COLUMN IF NOT EXISTS lease_token uuid,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS capacity_blocked_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_complete_snapshot_at timestamptz,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
  `);

  await pool.query(`
    ALTER TABLE watch_later_account
    DROP COLUMN IF EXISTS enabled,
    DROP COLUMN IF EXISTS requires_complete_refetch
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_later_account_operation (
      operation_id uuid PRIMARY KEY,
      account_id bigint NOT NULL REFERENCES watch_later_account(account_id),
      aid bigint NOT NULL,
      action text NOT NULL,
      intent_at timestamptz NOT NULL,
      request_attempt_count integer NOT NULL DEFAULT 0,
      last_request_at timestamptz,
      result_classification text NOT NULL DEFAULT 'pending',
      result_code integer,
      provenance_run_ref text,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_watch_later_account_operation_action CHECK (action IN ('add', 'delete')),
      CONSTRAINT chk_watch_later_account_operation_attempt_count CHECK (request_attempt_count >= 0),
      CONSTRAINT chk_watch_later_account_operation_result CHECK (result_classification IN ('pending', 'succeeded', 'failed', 'ambiguous', 'capacity_blocked')),
      CONSTRAINT chk_watch_later_account_operation_resolution CHECK (
        (result_classification IN ('pending', 'ambiguous') AND resolved_at IS NULL)
        OR (result_classification IN ('succeeded', 'failed', 'capacity_blocked') AND resolved_at IS NOT NULL)
      )
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_watch_later_account_operation_recovery
    ON watch_later_account_operation(account_id, intent_at ASC)
    WHERE result_classification IN ('pending', 'ambiguous')
  `);
  logger.info("watch-later: schema ready");
}
