import { z } from "zod";

export const telegramSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

export type TelegramConfig = z.infer<typeof telegramSchema>;
