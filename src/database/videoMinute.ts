import type { Pool } from "pg";
import type { VideoMinuteSample } from "../types/models/minute.js";

export async function insertVideoMinuteSamples(
  pool: Pool,
  samples: VideoMinuteSample[],
): Promise<number> {
  if (samples.length === 0) return 0;

  const result = await pool.query(
    `
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
    )
  `,
    [
      samples.map((sample) => sample.time),
      samples.map((sample) => sample.aid.toString()),
      samples.map((sample) => sample.coin ?? null),
      samples.map((sample) => sample.favorite ?? null),
      samples.map((sample) => sample.danmaku ?? null),
      samples.map((sample) => sample.view ?? null),
      samples.map((sample) => sample.reply ?? null),
      samples.map((sample) => sample.share ?? null),
      samples.map((sample) => sample.like ?? null),
    ],
  );

  return result.rowCount ?? 0;
}
