import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCollectionOutcome,
  parseCollectionReevaluationArgs,
} from "./reevaluate-collection.js";

test("re-evaluation refuses to run without an explicit range", () => {
  for (const args of [
    [],
    ["--apply", "--pre-image", "before.jsonl"],
    ["--max-batches", "1", "--allow-pull-legacy"],
    ["--tid-v2", "2022", "--tid-v1", "30"],
  ]) {
    assert.throws(
      () => parseCollectionReevaluationArgs(args),
      /An explicit range is required/,
      args.join(" "),
    );
  }
});

test("re-evaluation accepts each kind of range and defaults to a dry run", () => {
  for (const args of [
    ["--from-aid", "100"],
    ["--to-aid", "200"],
    ["--aids-file", "aids.txt"],
    ["--active-only"],
    ["--all"],
    ["--active-only", "--from-aid", "100"],
  ]) {
    const options = parseCollectionReevaluationArgs(args);
    assert.equal(options.apply, false, args.join(" "));
    assert.equal(options.batchSize, 5000);
  }
  assert.throws(
    () => parseCollectionReevaluationArgs(["--all", "--active-only"]),
    /only one of/,
  );
  assert.throws(
    () =>
      parseCollectionReevaluationArgs(["--from-aid", "10", "--to-aid", "5"]),
    /must not be greater/,
  );
  assert.throws(
    () => parseCollectionReevaluationArgs(["--all", "--form-aid", "1"]),
    /Unknown option/,
  );
});

test("--apply needs a pre-image file and evaluates against the table, not list arguments", () => {
  assert.throws(
    () => parseCollectionReevaluationArgs(["--all", "--apply"]),
    /requires --pre-image/,
  );
  assert.throws(
    () =>
      parseCollectionReevaluationArgs([
        "--all",
        "--apply",
        "--pre-image",
        "before.jsonl",
        "--tid-v2",
        "2022",
      ]),
    /edit the table/,
  );
  assert.throws(
    () =>
      parseCollectionReevaluationArgs(["--all", "--pre-image", "before.jsonl"]),
    /only used with --apply/,
  );
  const options = parseCollectionReevaluationArgs([
    "--all",
    "--apply",
    "--pre-image",
    "before.jsonl",
    "--allow-label-demotion",
  ]);
  assert.equal(options.apply, true);
  assert.equal(options.allowLabelDemotion, true);
  assert.equal(options.allowPullLegacy, false);
});

test("--restore takes no range or evaluation options", () => {
  const options = parseCollectionReevaluationArgs([
    "--restore",
    "before.jsonl",
    "--apply",
  ]);
  assert.equal(options.restoreFile, "before.jsonl");
  assert.equal(options.apply, true);
  assert.throws(
    () =>
      parseCollectionReevaluationArgs(["--restore", "before.jsonl", "--all"]),
    /--restore only takes/,
  );
});

test("outcomes tell new admissions from videos that were already in", () => {
  assert.equal(
    classifyCollectionOutcome("upserted_bootstrap", null, "v2"),
    "newly_admit_bootstrap",
  );
  assert.equal(
    classifyCollectionOutcome("new_upserted_backfill_daily_only", null, "v2"),
    "newly_admit_backfill",
  );
  assert.equal(
    classifyCollectionOutcome("refreshed_from_daily", null, "v2"),
    "newly_admit_daily",
  );
  assert.equal(
    classifyCollectionOutcome("upserted_bootstrap", 0, "v2"),
    "keep_active",
  );
  assert.equal(
    classifyCollectionOutcome("upserted_bootstrap", null, "v1"),
    "v2_unknown_v1_admit",
  );
  assert.equal(
    classifyCollectionOutcome("refreshed_from_daily", 10, "label"),
    "label_admit",
  );
  assert.equal(
    classifyCollectionOutcome("revived_upserted_bootstrap", -1, "v2"),
    "revive",
  );
});

test("outcomes name pull-outs, demotions and what is left alone", () => {
  const cases: [string, number | null, "label" | "v2" | "v1", string][] = [
    ["disabled_not_whitelisted", 10, "v2", "pull_out"],
    ["pull_out_blocked_protected", 10, "v2", "pull_out_blocked_protected"],
    ["disabled_label_demotion", 10, "label", "label_demotion"],
    [
      "label_demotion_blocked_protected",
      10,
      "label",
      "label_demotion_blocked_protected",
    ],
    ["ignored_not_whitelisted", 10, "v2", "keep_active"],
    ["ignored_not_whitelisted", -1, "v2", "unchanged_disabled"],
    ["ignored_not_whitelisted", null, "v2", "no_row_not_admitted"],
    ["ignored_label_not_ready", 10, "v1", "v2_unknown_no_v1"],
    ["ignored_label_not_ready", 10, "label", "label_not_ready"],
    ["ignored_existing_disabled", -1, "v2", "unchanged_disabled"],
    ["ignored_label_demotion", null, "label", "no_row_not_admitted"],
    ["disabled_deleted", 10, "v2", "disable_deleted"],
    ["ignored_filtered_out", null, "v2", "no_row_not_admitted"],
  ];
  for (const [decision, priority, basis, expected] of cases) {
    assert.equal(
      classifyCollectionOutcome(decision, priority, basis),
      expected,
      `${decision} ${priority} ${basis}`,
    );
  }
});
