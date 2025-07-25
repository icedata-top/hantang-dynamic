import { z } from "zod";

// Application behavior and execution settings
export const applicationSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  fetchInterval: z.coerce.number().default(900_000), // 15 minutes
  apiRetryTimes: z.coerce.number().default(3),
  apiWaitTime: z.coerce.number().default(2000),
  maxHistoryDays: z.coerce.number().default(7),
  maxItem: z.coerce.number().default(0),
});

export type ApplicationConfig = z.infer<typeof applicationSchema>;
