import assert from "node:assert/strict";
import test from "node:test";
import { createWhitelistConfig, whitelistSchema } from "./whitelist.js";

test("whitelist sections use TOML before environment values", () => {
  const toml = new Map<string, unknown>([
    ["whitelist.video.type_ids", [28]],
    ["whitelist.video.copyright_types", [1]],
    ["whitelist.video.content_keywords", ["music"]],
    ["whitelist.video.tid_v2", [2022, 2061]],
    ["whitelist.recommendation.pid_v2", [7]],
    ["whitelist.minute_bootstrap.label_content_types", ["vocaloid"]],
    ["whitelist.minute_bootstrap.label_origin", "rule"],
    ["whitelist.minute_bootstrap.label_writers", ["classification_apply"]],
    ["whitelist.minute_bootstrap.tid_v2", [2022]],
  ]);
  const result = createWhitelistConfig((path) => toml.get(path.join(".")));
  assert.deepEqual(result, {
    video: {
      typeIds: [28],
      tidV2: [2022, 2061],
      copyrightTypes: [1],
      contentKeywords: ["music"],
    },
    recommendation: { pidV2: [7] },
    minuteBootstrap: {
      labelContentTypes: ["vocaloid"],
      labelOrigin: "rule",
      labelWriters: ["classification_apply"],
      tidV2: [2022],
    },
  });
  assert.deepEqual(whitelistSchema.parse(result), result);
});

test("whitelist environment lists parse and defaults retain minute admission", () => {
  const env = new Map([
    ["TYPE_ID_WHITE_LIST", "28, 30"],
    ["TID_V2_WHITE_LIST", "2022, 2061"],
    ["COPYRIGHT_WHITE_LIST", "1, 2"],
    ["CONTENT_WHITE_LIST", "music, dance"],
    ["UPDATE_INFO_PID_V2_WHITELIST", "7, 11"],
    ["MINUTE_BOOTSTRAP_LABEL_WRITERS", "writer_one, writer_two"],
    ["MINUTE_BOOTSTRAP_TID_V2_ALLOWLIST", "2022, 2061"],
  ]);
  const result = createWhitelistConfig((_path, key) => env.get(key));
  assert.deepEqual(result.video, {
    typeIds: [28, 30],
    tidV2: [2022, 2061],
    copyrightTypes: [1, 2],
    contentKeywords: ["music", "dance"],
  });
  assert.deepEqual(result.recommendation.pidV2, [7, 11]);
  assert.deepEqual(result.minuteBootstrap, {
    labelContentTypes: ["vocaloid", "maybe_vocaloid"],
    labelOrigin: "rule",
    labelWriters: ["writer_one", "writer_two"],
    tidV2: [2022, 2061],
  });
  assert.throws(
    () =>
      createWhitelistConfig((_path, key) =>
        key === "UPDATE_INFO_PID_V2_WHITELIST" ? "7,,11" : undefined,
      ),
    /pidV2/,
  );
});

test("content keywords reject blank entries from environment and TOML", () => {
  assert.throws(
    () =>
      createWhitelistConfig((_path, key) =>
        key === "CONTENT_WHITE_LIST" ? "music, " : undefined,
      ),
    /contentKeywords/,
  );
  assert.throws(
    () =>
      createWhitelistConfig((path) =>
        path.join(".") === "whitelist.video.content_keywords"
          ? ["music", "   "]
          : undefined,
      ),
    /contentKeywords/,
  );
});

test("whitelist.video.tid_v2 reads TOML, then the environment, and defaults to empty", () => {
  assert.deepEqual(createWhitelistConfig(() => undefined).video.tidV2, []);
  const env = (value: string) => (_path: string[], key: string) =>
    key === "TID_V2_WHITE_LIST" ? value : undefined;
  assert.deepEqual(
    createWhitelistConfig(env("2022,2061")).video.tidV2,
    [2022, 2061],
  );
  assert.deepEqual(
    createWhitelistConfig((path, key) =>
      path.join(".") === "whitelist.video.tid_v2"
        ? [2037]
        : key === "TID_V2_WHITE_LIST"
          ? "2022"
          : undefined,
    ).video.tidV2,
    [2037],
  );
  assert.deepEqual(
    createWhitelistConfig((path) =>
      path.join(".") === "whitelist.video.tid_v2" ? [] : undefined,
    ).video.tidV2,
    [],
  );
  assert.throws(() => createWhitelistConfig(env("2022,x")), /tidV2/);
  assert.throws(() => createWhitelistConfig(env("2022,,2061")), /tidV2/);
});
