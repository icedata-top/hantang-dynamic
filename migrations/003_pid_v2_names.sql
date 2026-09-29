-- Migration: PID V2 name dictionary.
--
-- This table is independent of processed_videos and can be applied directly
-- to an existing database without running --init-schema.

CREATE TABLE IF NOT EXISTS pid_v2_names (
  pid_v2 INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
