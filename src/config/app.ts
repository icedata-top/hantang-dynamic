import { z } from "zod";

export const appSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  fetchInterval: z.coerce.number().default(900_000), // 15 minutes
  apiRetry: z.object({
    times: z.coerce.number().default(3),
    waitTime: z.coerce.number().default(2000),
  }),
  maxHistoryDays: z.coerce.number().default(7),
  maxItem: z.coerce.number().default(0),
  features: z.object({
    enableTagFetch: z.coerce.boolean().default(false),
    enableUserRelation: z.coerce.boolean().default(false),
  }),
  filtering: z.object({
    typeIdWhitelist: z.array(z.number()).default([]),
    contentBlacklist: z.array(z.string()).default([]),
    contentWhitelist: z.array(z.string()).default([]),
  }),
  deduplication: z.object({
    aidsDuckdbPath: z.string(),
  }),
});

export type AppConfig = z.infer<typeof appSchema>;
