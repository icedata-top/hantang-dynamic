import type { Pool } from "pg";
import type {
  PersistableVideoMinuteSample,
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

export interface VideoMinuteGateCrossing {
  aid: bigint;
  gateValue: bigint;
}

export interface VideoMinuteInsertResult {
  inserted: number;
  gateCrossings: VideoMinuteGateCrossing[];
}

async function getGateCrossingsForSamples(
  pool: Pool,
  samples: VideoMinuteSample[],
): Promise<VideoMinuteGateCrossing[]> {
  const result = await pool.query<{ aid: string; gate_value: string }>(
    `SELECT aid, gate_value
     FROM video_collection_gate_crossings
     WHERE aid = ANY($1::bigint[])
       AND crossed_at = ANY($2::timestamptz[])`,
    [
      samples.map((sample) => sample.aid.toString()),
      samples.map((sample) => sample.time),
    ],
  );
  return result.rows.map((row) => ({
    aid: BigInt(row.aid),
    gateValue: BigInt(row.gate_value),
  }));
}

/** Persist samples and return gate crossings created by this write. */
export async function insertVideoMinuteSamplesWithGateCrossings(
  pool: Pool,
  samples: VideoMinuteSample[],
): Promise<VideoMinuteInsertResult> {
  if (samples.length === 0) return { inserted: 0, gateCrossings: [] };

  const before = await getGateCrossingsForSamples(pool, samples);
  const result = await pool.query(
    INSERT_VIDEO_MINUTE_SQL,
    sampleParams(samples),
  );
  const previous = new Set(
    before.map((crossing) => `${crossing.aid}:${crossing.gateValue}`),
  );
  const gateCrossings = (
    await getGateCrossingsForSamples(pool, samples)
  ).filter(
    (crossing) => !previous.has(`${crossing.aid}:${crossing.gateValue}`),
  );

  return { inserted: result.rowCount ?? 0, gateCrossings };
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

export async function getLatestVideoMinuteSamples(
  pool: Pool,
  aids: bigint[],
): Promise<Map<bigint, PersistableVideoMinuteSample>> {
  if (aids.length === 0) return new Map();
  const result = await pool.query<{
    aid: string;
    time: Date;
    coin: number | null;
    favorite: number | null;
    danmaku: number | null;
    view: number;
    reply: number | null;
    share: number | null;
    like: number | null;
  }>(
    `SELECT DISTINCT ON (aid)
       aid, "time", coin, favorite, danmaku, "view", reply, share, "like"
     FROM video_minute
     WHERE aid = ANY($1::bigint[])
       AND "view" IS NOT NULL
     ORDER BY aid, "time" DESC`,
    [aids.map((aid) => aid.toString())],
  );

  return new Map(
    result.rows.map((row) => {
      const aid = BigInt(row.aid);
      return [
        aid,
        {
          aid,
          time: new Date(row.time),
          coin: row.coin,
          favorite: row.favorite,
          danmaku: row.danmaku,
          view: row.view,
          reply: row.reply,
          share: row.share,
          like: row.like,
        },
      ];
    }),
  );
}
