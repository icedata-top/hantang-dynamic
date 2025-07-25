import { z } from "zod";

export const bilibiliSchema = z.object({
  uid: z.string().min(1),
  sessdata: z.string().min(1),
  csrfToken: z.string().optional(),
  accessKey: z.string().optional(),
});

export type BilibiliConfig = z.infer<typeof bilibiliSchema>;
