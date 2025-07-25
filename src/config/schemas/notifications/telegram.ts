import { z } from "zod";

// Telegram notification configuration
export const telegramSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

export type TelegramConfig = z.infer<typeof telegramSchema>;

// Factory function to create telegram config from TOML/env
export function createTelegramConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): TelegramConfig {
  return {
    botToken: getConfigValue(
      ["notifications", "telegram", "bot_token"],
      "TELEGRAM_BOT_TOKEN",
    ),
    chatId: getConfigValue(
      ["notifications", "telegram", "chat_id"],
      "TELEGRAM_CHAT_ID",
    ),
  };
}
