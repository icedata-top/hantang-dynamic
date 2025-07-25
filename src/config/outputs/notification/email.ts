import { z } from "zod";

export const emailSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type EmailConfig = z.infer<typeof emailSchema>;
