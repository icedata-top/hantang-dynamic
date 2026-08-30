import type { Pool, QueryResult } from "pg";
import { logger } from "../../utils/logger.js";

const MISSION_BACKFILL_BATCH_SIZE = 10_000;

export async function backfillMissionIds(pool: Pool): Promise<void> {
  let processed = 0;
  let lastAid: bigint | null = null;
  while (true) {
    const result: QueryResult<{ aid: string }> = await pool.query(
      `
      WITH candidates AS (
        SELECT aid,
               CASE
                 WHEN btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013') ~ '^[+-]?[0-9]+$'
                   AND length(regexp_replace(btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013'), '^[+-]?0*', '')) <= 19
                 THEN CASE
                        WHEN btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013')::numeric BETWEEN -9223372036854775808 AND 9223372036854775807
                        THEN btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013')::bigint
                      END
               END AS mission_id
        FROM processed_videos
        WHERE mission_id IS NULL
          AND ($1::bigint IS NULL OR aid > $1::bigint)
          AND CASE
                WHEN btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013') ~ '^[+-]?[0-9]+$'
                  AND length(regexp_replace(btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013'), '^[+-]?0*', '')) <= 19
                THEN btrim(extras->>'mission_id', E' \\t\\n\\r\\f\\013')::numeric BETWEEN -9223372036854775808 AND 9223372036854775807
                ELSE FALSE
              END
        ORDER BY aid
        LIMIT ${MISSION_BACKFILL_BATCH_SIZE}
        FOR UPDATE
      )
      UPDATE processed_videos AS video
      SET mission_id = candidates.mission_id
      FROM candidates
      WHERE video.aid = candidates.aid
        AND video.mission_id IS NULL
      RETURNING video.aid
    `,
      [lastAid?.toString() ?? null],
    );
    const updated = result.rowCount ?? 0;
    if (updated === 0) break;

    for (const row of result.rows) {
      const aid = BigInt(row.aid);
      if (lastAid === null || aid > lastAid) lastAid = aid;
    }
    processed += updated;
    logger.info(`Processed-video mission backfill processed: ${processed}`);
  }
}

export async function initVideosSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_videos (
      aid BIGINT PRIMARY KEY,
      bvid VARCHAR UNIQUE NOT NULL,
      pubdate BIGINT,
      title VARCHAR,
      description TEXT,
      tag TEXT,
      pic VARCHAR,
      type_id INTEGER,
      user_id BIGINT,
      is_filtered BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      staff BIGINT[],
      tid_v2 INTEGER,
      dynamic TEXT,
      tag_new VARCHAR[],
      participle VARCHAR[],
      ctime BIGINT,
      is_deleted BOOLEAN DEFAULT FALSE,
      copyright INTEGER,
      pid_v2 INTEGER,
      mission_id BIGINT,
      extras JSONB,
      notes JSONB
    )
  `);

  await pool.query(`
    ALTER TABLE processed_videos
      ADD COLUMN IF NOT EXISTS pid_v2 INTEGER,
      ADD COLUMN IF NOT EXISTS mission_id BIGINT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tags (
      tag_id BIGINT PRIMARY KEY,
      tag_name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_tags (
      video_aid BIGINT NOT NULL,
      tag_id BIGINT NOT NULL,
      PRIMARY KEY (video_aid, tag_id)
    )
  `);

  await pool.query(`DROP INDEX IF EXISTS idx_processed_bvid`);
  await pool.query(`DROP INDEX IF EXISTS idx_processed_user`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_filtered
    ON processed_videos(is_filtered)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_user_stats
    ON processed_videos(user_id)
    INCLUDE (aid, is_filtered, is_deleted)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_pid_v2
    ON processed_videos(pid_v2)
    WHERE pid_v2 IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_processed_mission_id
    ON processed_videos(mission_id)
    WHERE mission_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_video_tags_tag_id_video_aid
    ON video_tags(tag_id, video_aid)
  `);
}
