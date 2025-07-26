import { z } from "zod";
import { createEmailConfig, emailSchema } from "./email";
import { createTelegramConfig, telegramSchema } from "./telegram";
import { createHttpConfig, httpSchema } from "./http";

// Combined notifications configuration
export const notificationsSchema = z.object({
  email: emailSchema,
  telegram: telegramSchema,
  http: httpSchema,
});

export type NotificationsConfig = z.infer<typeof notificationsSchema>;

// Re-export individual types
export type { EmailConfig } from "./email";
export type { TelegramConfig } from "./telegram";
export type { HttpConfig, HttpRequestConfig, HttpMethod } from "./http";

// Factory function to create notifications config from TOML/env
export function createNotificationsConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): NotificationsConfig {
  return {
    email: createEmailConfig(getConfigValue),
    telegram: createTelegramConfig(getConfigValue),
    http: createHttpConfig(getConfigValue),
  };
}
