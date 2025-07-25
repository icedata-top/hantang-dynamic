import { z } from "zod";

// Bilibili authentication and API configuration
export const bilibiliSchema = z.object({
  uid: z.string(),
  sessdata: z.string(),
  csrfToken: z.string().optional(),
  accessKey: z.string().optional(),
});

export type BilibiliConfig = z.infer<typeof bilibiliSchema>;
