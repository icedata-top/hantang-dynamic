import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const serverSchema = z.object({
  enabled: configBoolean.default(false),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(9469),
  authToken: z.string().optional(),
});

export type ServerConfig = z.infer<typeof serverSchema>;

export function createServerConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): ServerConfig {
  return serverSchema.parse({
    enabled: getConfigValue(
      ["server", "enabled"],
      "SERVER_ENABLED",
      getConfigValue(["metrics", "enabled"], "METRICS_ENABLED", false),
    ),
    host: getConfigValue(
      ["server", "host"],
      "SERVER_HOST",
      getConfigValue(["metrics", "host"], "METRICS_HOST", "127.0.0.1"),
    ),
    port: getConfigValue(
      ["server", "port"],
      "SERVER_PORT",
      getConfigValue(["metrics", "port"], "METRICS_PORT", 9469),
    ),
    authToken: getConfigValue(
      ["server", "auth_token"],
      "SERVER_AUTH_TOKEN",
      getConfigValue(
        ["metrics", "auth_token"],
        "METRICS_AUTH_TOKEN",
        undefined,
      ),
    ),
  });
}
