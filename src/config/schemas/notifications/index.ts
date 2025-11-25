import { z } from "zod";
import { createEmailConfig, emailSchema } from "./email";
import { createHttpConfig, httpSchema } from "./http";
import { createTelegramConfig, telegramSchema } from "./telegram";

// Combined notifications configuration
export const notificationsSchema = z.object({
  email: emailSchema,
  telegram: telegramSchema,
  http: httpSchema,
});

export type NotificationsConfig = z.infer<typeof notificationsSchema>;

// Re-export individual types
export type { EmailConfig } from "./email";
export type { HttpConfig, HttpMethod, HttpRequestConfig } from "./http";
export type { TelegramConfig } from "./telegram";

// Factory function to create notifications config from TOML/env
export function createNotificationsConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): NotificationsConfig {
  return {
    email: createEmailConfig(getConfigValue),
    telegram: createTelegramConfig(getConfigValue),
    http: createHttpConfig(getConfigValue),
  };
}
