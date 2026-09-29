import assert from "node:assert/strict";
import test from "node:test";
import { createProcessingConfig } from "./processing.js";

test("content blacklist keeps TOML precedence and parses environment entries", () => {
  const fromToml = createProcessingConfig((path, envKey) =>
    path.join(".") === "processing.filtering.content_blacklist"
      ? ["skip"]
      : envKey === "CONTENT_BLACK_LIST"
        ? "other, word"
        : undefined,
  );
  assert.deepEqual(fromToml.filtering.contentBlacklist, ["skip"]);
  const fromEnvironment = createProcessingConfig((_path, envKey) =>
    envKey === "CONTENT_BLACK_LIST" ? "other, word" : undefined,
  );
  assert.deepEqual(fromEnvironment.filtering.contentBlacklist, [
    "other",
    "word",
  ]);
});
