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

export type EmailConfig = z.infer<typeof emailSchema>;

// Factory function to create email config from TOML/env
export function createEmailConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    defaultValue?: any,
  ) => any,
): EmailConfig {
  return {
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
  };
}
