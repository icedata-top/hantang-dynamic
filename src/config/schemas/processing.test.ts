import assert from "node:assert/strict";
import test from "node:test";
import { createProcessingConfig, processingSchema } from "./processing.js";

test("pid_v2 whitelist prefers TOML values and validates every entry", () => {
  const config = createProcessingConfig((path, envKey) => {
    if (path.join(".") === "processing.filtering.pid_v2_whitelist") {
      return [7, 11];
    }
    return envKey === "UPDATE_INFO_PID_V2_WHITELIST" ? "13,17" : undefined;
  });
  assert.deepEqual(config.filtering.pidV2Whitelist, [7, 11]);
  const environmentConfig = createProcessingConfig((_path, envKey) =>
    envKey === "UPDATE_INFO_PID_V2_WHITELIST" ? "13,17" : undefined,
  );
  assert.deepEqual(environmentConfig.filtering.pidV2Whitelist, [13, 17]);
  assert.throws(
    () =>
      processingSchema.parse({
        features: {},
        filtering: { pidV2Whitelist: [7, 1.5] },
      }),
    /pidV2Whitelist/,
  );
});
