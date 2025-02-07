import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  UID: z.string().min(1),
  SESSDATA: z.string().min(1),
  FETCH_INTERVAL: z.coerce.number().default(900_000), // 15 minutes
  API_WAIT_TIME: z.coerce.number().default(2000),
  MAX_HISTORY_DAYS: z.coerce.number().default(7),
  ENABLE_TAG_FETCH: z.coerce.boolean().default(false),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse({
  UID: process.env.UID,
  SESSDATA: process.env.SESSDATA,
  FETCH_INTERVAL: process.env.FETCH_INTERVAL,
  API_WAIT_TIME: process.env.API_WAIT_TIME,
  MAX_HISTORY_DAYS: process.env.MAX_HISTORY_DAYS,
  ENABLE_TAG_FETCH: process.env.ENABLE_TAG_FETCH,
});
