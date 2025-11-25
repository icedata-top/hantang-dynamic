import { z } from "zod";

// Telegram notification configuration
export const telegramSchema = z.object({
  enabled: z.boolean().optional().default(false),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

export type TelegramConfig = z.infer<typeof telegramSchema>;

// Factory function to create telegram config from TOML/env
export function createTelegramConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): TelegramConfig {
  return {
    enabled: getConfigValue(
      ["notifications", "telegram", "enabled"],
      "TELEGRAM_ENABLED",
      false,
    ),
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
