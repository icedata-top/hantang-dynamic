import { z } from "zod";

const configBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const repairSchema = z.object({
  apiEnabled: configBoolean.default(false),
  batchConcurrency: z.coerce.number().int().positive().max(64).default(4),
  path: z.string().startsWith("/").default("/repair"),
  statusPath: z.string().startsWith("/").default("/repair/status"),
  maxBvids: z.coerce.number().int().positive().max(10_000).default(1000),
});

export type RepairConfig = z.infer<typeof repairSchema>;

export function createRepairConfig(
  getConfigValue: (
    tomlPath: string[],
    envKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
    defaultValue?: any,
    // biome-ignore lint/suspicious/noExplicitAny: Config values from TOML/env are inherently untyped and validated by zod
  ) => any,
): RepairConfig {
  return repairSchema.parse({
    apiEnabled: getConfigValue(
      ["repair", "api_enabled"],
      "REPAIR_API_ENABLED",
      false,
    ),
    batchConcurrency: getConfigValue(
      ["repair", "batch_concurrency"],
      "REPAIR_BATCH_CONCURRENCY",
      4,
    ),
    path: getConfigValue(["repair", "path"], "REPAIR_PATH", "/repair"),
    statusPath: getConfigValue(
      ["repair", "status_path"],
      "REPAIR_STATUS_PATH",
      "/repair/status",
    ),
    maxBvids: getConfigValue(["repair", "max_bvids"], "REPAIR_MAX_BVIDS", 1000),
  });
}
