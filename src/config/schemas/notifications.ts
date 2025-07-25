import { z } from "zod";

// Email notification configuration
export const emailSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// Telegram notification configuration
export const telegramSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

// Combined notifications configuration
export const notificationsSchema = z.object({
  email: emailSchema,
  telegram: telegramSchema,
});

export type EmailConfig = z.infer<typeof emailSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type NotificationsConfig = z.infer<typeof notificationsSchema>;
