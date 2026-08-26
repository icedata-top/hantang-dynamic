import { z } from "zod";
import type { BiliToViewItem } from "../../types/bilibili/toview";
import type { CompleteVideoMinuteTuple } from "../../types/models/minute";

const safeAid = z.number().int().safe().positive();
const counter = z.number().int().min(0).max(2_147_483_647);
const pidV2 = z.number().int().positive().max(2_147_483_647);

const toViewItemSchema = z.object({
  aid: safeAid,
  pid_v2: z.unknown().optional(),
  stat: z.object({
    aid: safeAid,
    coin: counter,
    favorite: counter,
    danmaku: counter,
    view: counter,
    reply: counter,
    share: counter,
    like: counter,
  }),
});

const toViewResponseSchema = z.object({
  code: z.number().int(),
  message: z.string().optional(),
  ttl: z.number().int().optional(),
  data: z
    .object({
      count: z.number().int().nonnegative(),
      list: z.array(z.unknown()),
    })
    .optional(),
});

export interface ToViewValidationResult {
  samples: CompleteVideoMinuteTuple[];
  invalidItemCount: number;
  invalidPidV2Count: number;
  pidV2Metadata: Array<{ aid: bigint; pidV2: number }>;
  responseCode: number | null;
}

function toSample(
  item: BiliToViewItem,
  sampledAt: Date,
): CompleteVideoMinuteTuple {
  return {
    aid: BigInt(item.aid),
    time: sampledAt,
    coin: item.stat.coin,
    favorite: item.stat.favorite,
    danmaku: item.stat.danmaku,
    view: item.stat.view,
    reply: item.stat.reply,
    share: item.stat.share,
    like: item.stat.like,
  };
}

export function validateToViewResponse(
  value: unknown,
  sampledAt: Date,
): ToViewValidationResult {
  const responseResult = toViewResponseSchema.safeParse(value);
  if (!responseResult.success) {
    return {
      samples: [],
      invalidItemCount: 1,
      invalidPidV2Count: 0,
      pidV2Metadata: [],
      responseCode: null,
    };
  }

  const response = responseResult.data;
  if (response.code !== 0 || !response.data) {
    return {
      samples: [],
      invalidItemCount: 0,
      invalidPidV2Count: 0,
      pidV2Metadata: [],
      responseCode: response.code,
    };
  }

  const samples: CompleteVideoMinuteTuple[] = [];
  const pidV2Metadata: Array<{ aid: bigint; pidV2: number }> = [];
  const seenAids = new Set<number>();
  let invalidItemCount = 0;
  let invalidPidV2Count = 0;

  for (const valueItem of response.data.list) {
    const itemResult = toViewItemSchema.safeParse(valueItem);
    if (
      !itemResult.success ||
      itemResult.data.aid !== itemResult.data.stat.aid
    ) {
      invalidItemCount += 1;
      continue;
    }

    if (seenAids.has(itemResult.data.aid)) {
      invalidItemCount += 1;
      continue;
    }

    seenAids.add(itemResult.data.aid);
    samples.push(toSample(itemResult.data, sampledAt));
    const parsedPidV2 = pidV2.safeParse(itemResult.data.pid_v2);
    if (parsedPidV2.success) {
      pidV2Metadata.push({
        aid: BigInt(itemResult.data.aid),
        pidV2: parsedPidV2.data,
      });
    } else {
      invalidPidV2Count += 1;
    }
  }

  return {
    samples,
    invalidItemCount,
    invalidPidV2Count,
    pidV2Metadata,
    responseCode: response.code,
  };
}
