import type { Pool } from "pg";
import type { VideoMinuteSample } from "../types/models/minute.js";

const INSERT_VIDEO_MINUTE_SQL = `
  WITH incoming AS (
    SELECT *
    FROM unnest(
      $1::timestamptz[],
      $2::bigint[],
      $3::integer[],
      $4::integer[],
      $5::integer[],
      $6::integer[],
      $7::integer[],
      $8::integer[],
      $9::integer[]
    ) AS t(
      "time",
      aid,
      coin,
      favorite,
      danmaku,
      "view",
      reply,
      share,
      "like"
    )
  ),
  deduped AS (
    SELECT DISTINCT ON (aid, "time")
      "time",
      aid,
      coin,
      favorite,
      danmaku,
      "view",
      reply,
      share,
      "like"
    FROM incoming
    ORDER BY aid, "time"
  )
  INSERT INTO video_minute (
    "time",
    aid,
    coin,
    favorite,
    danmaku,
    "view",
    reply,
    share,
    "like"
  )
  SELECT
    d."time",
    d.aid,
    d.coin,
    d.favorite,
    d.danmaku,
    d."view",
    d.reply,
    d.share,
    d."like"
  FROM deduped d
  WHERE NOT EXISTS (
    SELECT 1
    FROM video_minute vm
    WHERE vm.aid = d.aid
      AND vm."time" = d."time"
  )
`;

function sampleParams(samples: VideoMinuteSample[]): unknown[] {
  return [
    samples.map((sample) => sample.time),
    samples.map((sample) => sample.aid.toString()),
    samples.map((sample) => sample.coin ?? null),
    samples.map((sample) => sample.favorite ?? null),
    samples.map((sample) => sample.danmaku ?? null),
    samples.map((sample) => sample.view ?? null),
    samples.map((sample) => sample.reply ?? null),
    samples.map((sample) => sample.share ?? null),
    samples.map((sample) => sample.like ?? null),
  ];
}

export async function insertVideoMinuteSamples(
  pool: Pool,
  samples: VideoMinuteSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  const result = await pool.query(
    INSERT_VIDEO_MINUTE_SQL,
    sampleParams(samples),
  );

  return result.rowCount ?? 0;
}
