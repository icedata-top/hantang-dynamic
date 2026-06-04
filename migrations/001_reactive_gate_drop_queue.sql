-- Migration: Reactive gate detection + queue elimination + cron fixes
--
-- Deployment order:
--   1. Deploy new code (handler stops using video_collection_queue)
--   2. Run --init-schema (creates new functions, alters tables)
--   3. Run this migration (cleans up queue, backfills next_gate_value)
--
-- Running step 3 before step 1 risks TRUNCATE conflicting with
-- in-flight queue operations from the old handler.
-- ──────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Abandon all remaining queue tasks (handler no longer uses the queue)
UPDATE video_collection_queue
SET status = 'abandoned', locked_until = NULL, updated_at = now()
WHERE status IN ('pending', 'leased');

-- 2. Backfill next_gate_value for all existing state rows
--    Requires fn_video_collection_next_gate_value from --init-schema (step 2)
UPDATE video_collection_state
SET next_gate_value = fn_video_collection_next_gate_value(last_view)
WHERE last_view IS NOT NULL
  AND next_gate_value IS NULL;

-- 3. Purge queue history (no longer written or read)
TRUNCATE video_collection_queue;

COMMIT;
