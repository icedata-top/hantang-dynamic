-- Migration: Reactive gate detection + queue elimination + cron fixes
-- Run AFTER --init-schema
-- ──────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Abandon all remaining queue tasks (handler no longer uses the queue)
UPDATE video_collection_queue
SET status = 'abandoned', locked_until = NULL, updated_at = now()
WHERE status IN ('pending', 'leased');

-- 2. Backfill next_gate_value for all existing state rows
UPDATE video_collection_state
SET next_gate_value = fn_video_collection_next_gate_value(last_view)
WHERE last_view IS NOT NULL
  AND next_gate_value IS NULL;

-- 3. Purge queue history (no longer written or read)
TRUNCATE video_collection_queue;

COMMIT;
