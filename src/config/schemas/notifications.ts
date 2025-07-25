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

export function createNotificationsConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): NotificationsConfig {
  return {
    email: {
      host: getConfigValue(["notifications", "email", "host"], "EMAIL_HOST"),
      port: getConfigValue(["notifications", "email", "port"], "EMAIL_PORT"),
      username: getConfigValue(
        ["notifications", "email", "username"],
        "EMAIL_USER",
      ),
      password: getConfigValue(
        ["notifications", "email", "password"],
        "EMAIL_PASS",
      ),
      from: getConfigValue(["notifications", "email", "from"], "EMAIL_FROM"),
      to: getConfigValue(["notifications", "email", "to"], "EMAIL_TO"),
    },
    telegram: {
      botToken: getConfigValue(
        ["notifications", "telegram", "bot_token"],
        "TELEGRAM_BOT_TOKEN",
      ),
      chatId: getConfigValue(
        ["notifications", "telegram", "chat_id"],
        "TELEGRAM_CHAT_ID",
      ),
    },
  };
}
