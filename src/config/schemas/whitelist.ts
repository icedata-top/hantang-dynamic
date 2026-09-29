import { z } from "zod";

const stringList = z.array(z.string());
const numberList = z.array(z.number());

export const legacyWhitelistPaths = [
  ["processing.filtering.type_id_whitelist", "whitelist.video.type_ids"],
  [
    "processing.filtering.copyright_whitelist",
    "whitelist.video.copyright_types",
  ],
  [
    "processing.filtering.content_whitelist",
    "whitelist.video.content_keywords",
  ],
  ["processing.filtering.pid_v2_whitelist", "whitelist.recommendation.pid_v2"],
  [
    "minute.bootstrap_label_content_types",
    "whitelist.minute_bootstrap.label_content_types",
  ],
  ["minute.bootstrap_label_origin", "whitelist.minute_bootstrap.label_origin"],
  [
    "minute.bootstrap_label_writers",
    "whitelist.minute_bootstrap.label_writers",
  ],
  ["minute.bootstrap_tid_v2_allowlist", "whitelist.minute_bootstrap.tid_v2"],
] as const;

export const whitelistSchema = z.object({
  video: z.object({
    typeIds: numberList.default([]),
    copyrightTypes: numberList.default([]),
    contentKeywords: z.array(z.string().trim().min(1)).default([]),
  }),
  recommendation: z.object({
    pidV2: z.array(z.number().int().positive()).default([]),
  }),
  minuteBootstrap: z.object({
    labelContentTypes: stringList.default(["vocaloid", "maybe_vocaloid"]),
    labelOrigin: z.string().default("rule"),
    labelWriters: stringList.default([
      "classification_apply",
      "classification_trigger",
    ]),
    tidV2: z.array(z.number().int()).default([2022, 2061]),
  }),
});

export type WhitelistConfig = z.infer<typeof whitelistSchema>;

type ConfigValue = (
  tomlPath: string[],
  envKey: string,
  // biome-ignore lint/suspicious/noExplicitAny: TOML/env values are validated by zod
  defaultValue?: any,
  // biome-ignore lint/suspicious/noExplicitAny: TOML/env values are validated by zod
) => any;

function listValue(value: unknown): unknown {
  return typeof value === "string"
    ? value.split(",").map((entry) => entry.trim())
    : value;
}

function numberListValue(value: unknown): unknown {
  const entries = listValue(value);
  return Array.isArray(entries) && typeof value === "string"
    ? entries.map((entry) => (entry === "" ? Number.NaN : Number(entry)))
    : entries;
}

export function createWhitelistConfig(
  getConfigValue: ConfigValue,
): WhitelistConfig {
  return whitelistSchema.parse({
    video: {
      typeIds: numberListValue(
        getConfigValue(
          ["whitelist", "video", "type_ids"],
          "TYPE_ID_WHITE_LIST",
          [],
        ),
      ),
      copyrightTypes: numberListValue(
        getConfigValue(
          ["whitelist", "video", "copyright_types"],
          "COPYRIGHT_WHITE_LIST",
          [],
        ),
      ),
      contentKeywords: listValue(
        getConfigValue(
          ["whitelist", "video", "content_keywords"],
          "CONTENT_WHITE_LIST",
          [],
        ),
      ),
    },
    recommendation: {
      pidV2: numberListValue(
        getConfigValue(
          ["whitelist", "recommendation", "pid_v2"],
          "UPDATE_INFO_PID_V2_WHITELIST",
          [],
        ),
      ),
    },
    minuteBootstrap: {
      labelContentTypes: listValue(
        getConfigValue(
          ["whitelist", "minute_bootstrap", "label_content_types"],
          "MINUTE_BOOTSTRAP_LABEL_CONTENT_TYPES",
          ["vocaloid", "maybe_vocaloid"],
        ),
      ),
      labelOrigin: getConfigValue(
        ["whitelist", "minute_bootstrap", "label_origin"],
        "MINUTE_BOOTSTRAP_LABEL_ORIGIN",
        "rule",
      ),
      labelWriters: listValue(
        getConfigValue(
          ["whitelist", "minute_bootstrap", "label_writers"],
          "MINUTE_BOOTSTRAP_LABEL_WRITERS",
          ["classification_apply", "classification_trigger"],
        ),
      ),
      tidV2: numberListValue(
        getConfigValue(
          ["whitelist", "minute_bootstrap", "tid_v2"],
          "MINUTE_BOOTSTRAP_TID_V2_ALLOWLIST",
          [2022, 2061],
        ),
      ),
    },
  });
}
