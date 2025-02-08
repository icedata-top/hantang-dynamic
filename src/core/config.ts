import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  BILIBILI_UID: z.string().min(1),
  SESSDATA: z.string().min(1),
  FETCH_INTERVAL: z.coerce.number().default(900_000), // 15 minutes
  API_RETRY_TIMES: z.coerce.number().default(3),
  API_WAIT_TIME: z.coerce.number().default(2000),
  MAX_HISTORY_DAYS: z.coerce.number().default(7),
  ENABLE_TAG_FETCH: z.coerce.boolean().default(false),
  TYPE_ID_WHITE_LIST: z.array(z.number()).default([]),

  MYSQL_IP: z.string().optional(),
  MYSQL_PORT: z.coerce.number().optional(),
  MYSQL_USERNAME: z.string().optional(),
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_TABLE: z.string().optional(),
  MYSQL_DATABASE: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse({
  BILIBILI_UID: process.env.BILIBILI_UID,
  SESSDATA: process.env.SESSDATA,
  FETCH_INTERVAL: process.env.FETCH_INTERVAL,
  API_RETRY_TIMES: process.env.API_RETRY_TIMES,
  API_WAIT_TIME: process.env.API_WAIT_TIME,
  MAX_HISTORY_DAYS: process.env.MAX_HISTORY_DAYS,
  ENABLE_TAG_FETCH: process.env.ENABLE_TAG_FETCH,
  TYPE_ID_WHITE_LIST: process.env.TYPE_ID_WHITE_LIST
    ? process.env.TYPE_ID_WHITE_LIST.split(",").map(Number)
    : [],
  MYSQL_IP: process.env.MYSQL_IP,
  MYSQL_PORT: process.env.MYSQL_PORT,
  MYSQL_USERNAME: process.env.MYSQL_USERNAME,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD,
  MYSQL_TABLE: process.env.MYSQL_TABLE,
  MYSQL_DATABASE: process.env.MYSQL_DATABASE,

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
});
