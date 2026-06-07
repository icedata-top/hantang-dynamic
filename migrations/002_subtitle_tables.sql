-- Migration: subtitle storage backfill.
--
-- Deployment order:
--   1. Deploy code.
--   2. Run --init-schema to create video_subtitles, subtitle_state, helper
--      functions, and gate-crossing trigger.
--   3. Run this migration to mark already-eligible videos as pending.
--
-- Future videos are marked by schema functions/triggers when their state row is
-- updated, but videos that crossed 10k before this feature existed need this
-- one-time backfill.

BEGIN;

UPDATE video_collection_state
SET subtitle_state = fn_next_subtitle_state(subtitle_state, last_view, NULL),
    updated_at = now()
WHERE subtitle_state IS DISTINCT FROM fn_next_subtitle_state(
  subtitle_state,
  last_view,
  NULL
);

COMMIT;
