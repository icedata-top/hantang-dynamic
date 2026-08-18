import type { Pool } from "pg";
import type {
  CompleteVideoMinuteTuple,
  VideoMinuteSample,
} from "../types/models/minute.js";

const INSERT_VIDEO_MINUTE_SQL = `
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
  ORDER BY aid, "time"
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

export async function getLatestCompleteVideoMinuteTuple(
  pool: Pool,
  aid: bigint,
): Promise<CompleteVideoMinuteTuple | null> {
  const result = await pool.query<{
    aid: string;
    time: Date;
    coin: number;
    favorite: number;
    danmaku: number;
    view: number;
    reply: number;
    share: number;
    like: number;
  }>(
    `SELECT aid, "time", coin, favorite, danmaku, "view", reply, share, "like"
     FROM video_minute
     WHERE aid = $1
       AND coin IS NOT NULL
       AND favorite IS NOT NULL
       AND danmaku IS NOT NULL
       AND "view" IS NOT NULL
       AND reply IS NOT NULL
       AND share IS NOT NULL
       AND "like" IS NOT NULL
     ORDER BY "time" DESC
     LIMIT 1`,
    [aid.toString()],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    aid: BigInt(row.aid),
    time: new Date(row.time),
    coin: row.coin,
    favorite: row.favorite,
    danmaku: row.danmaku,
    view: row.view,
    reply: row.reply,
    share: row.share,
    like: row.like,
  };
}
