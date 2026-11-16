import { open, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { config } from "../config/index.js";
import {
  COLLECTION_PROTECTION_RELEASE_SETTINGS,
  collectionDecisionSql,
  completeFormalLabelSql,
} from "../database/schema/collection_state.js";

/**
 * Re-evaluates stored videos against the monitoring rules in explicit aid
 * ranges, one batch per transaction.
 *
 * By default it is a dry run: every batch runs in a read-only transaction and
 * evaluates the same decision expression the upsert uses, inlined into a
 * plain query with the whitelist values passed as arguments. It needs neither
 * collection_whitelist nor the monitor_source column, so it also runs on a
 * database that has not been upgraded yet.
 *
 * Only --apply writes. Each batch then locks its state rows, appends their
 * full rows (or "no row") to the pre-image file, and re-evaluates every video
 * through fn_reevaluate_collection_whitelist, which reads the video again
 * right before evaluating it. --restore puts the rows of a pre-image file
 * back.
 */

export interface CollectionReevaluationOptions {
  apply: boolean;
  fromAid?: number;
  toAid?: number;
  aidsFile?: string;
  activeOnly: boolean;
  all: boolean;
  maxBatches?: number;
  batchSize: number;
  statementTimeout: string;
  lockTimeout: string;
  tidV2?: number[];
  tidV1?: number[];
  exactDailyHistory: boolean;
  allowPullLegacy: boolean;
  allowLabelDemotion: boolean;
  preImageFile?: string;
  detailsFile?: string;
  restoreFile?: string;
}

const FLAGS = new Set([
  "--apply",
  "--active-only",
  "--all",
  "--exact-daily-history",
  "--allow-pull-legacy",
  "--allow-label-demotion",
]);
const VALUE_OPTIONS = new Set([
  "--from-aid",
  "--to-aid",
  "--aids-file",
  "--batch",
  "--max-batches",
  "--statement-timeout",
  "--lock-timeout",
  "--tid-v2",
  "--tid-v1",
  "--pre-image",
  "--details",
  "--restore",
]);
const RESTORE_OPTIONS = new Set([
  "--restore",
  "--apply",
  "--batch",
  "--statement-timeout",
  "--lock-timeout",
]);

function nonNegativeInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} needs a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function integerList(name: string, value: string): number[] {
  if (value.trim() === "") return [];
  return value.split(",").map((entry) => {
    const trimmed = entry.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`${name} needs comma-separated integers, got "${value}"`);
    }
    return Number(trimmed);
  });
}

/** Parses the command-line options; throws on anything incomplete or unknown. */
export function parseCollectionReevaluationArgs(
  args: string[],
): CollectionReevaluationOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (FLAGS.has(arg)) {
      flags.add(arg);
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      if (values.has(arg)) throw new Error(`${arg} may only be given once`);
      values.set(arg, value);
      index++;
    } else {
      throw new Error(`Unknown option for --reevaluate-collection: ${arg}`);
    }
  }

  const batchSize = values.has("--batch")
    ? nonNegativeInteger("--batch", values.get("--batch") as string)
    : 5000;
  if (batchSize < 1) throw new Error("--batch must be at least 1");
  const base = {
    apply: flags.has("--apply"),
    batchSize,
    statementTimeout: values.get("--statement-timeout") ?? "60s",
    lockTimeout: values.get("--lock-timeout") ?? "5s",
  };

  const restoreFile = values.get("--restore");
  if (restoreFile !== undefined) {
    const extra = [...flags, ...values.keys()].filter(
      (option) => !RESTORE_OPTIONS.has(option),
    );
    if (extra.length > 0) {
      throw new Error(
        `--restore only takes --apply, --batch, --statement-timeout and --lock-timeout, not ${extra.join(", ")}`,
      );
    }
    return {
      ...base,
      activeOnly: false,
      all: false,
      allowLabelDemotion: false,
      allowPullLegacy: false,
      exactDailyHistory: false,
      restoreFile,
    };
  }

  const fromAid = values.has("--from-aid")
    ? nonNegativeInteger("--from-aid", values.get("--from-aid") as string)
    : undefined;
  const toAid = values.has("--to-aid")
    ? nonNegativeInteger("--to-aid", values.get("--to-aid") as string)
    : undefined;
  const aidsFile = values.get("--aids-file");
  const activeOnly = flags.has("--active-only");
  const all = flags.has("--all");

  const selections = [aidsFile !== undefined, activeOnly, all].filter(Boolean);
  if (selections.length > 1) {
    throw new Error("Use only one of --aids-file, --active-only and --all");
  }
  if (selections.length === 0 && fromAid === undefined && toAid === undefined) {
    throw new Error(
      "An explicit range is required: --from-aid/--to-aid, --aids-file, --active-only, or --all for every stored video",
    );
  }
  if (fromAid !== undefined && toAid !== undefined && fromAid > toAid) {
    throw new Error("--from-aid must not be greater than --to-aid");
  }

  const tidV2 = values.has("--tid-v2")
    ? integerList("--tid-v2", values.get("--tid-v2") as string)
    : undefined;
  const tidV1 = values.has("--tid-v1")
    ? integerList("--tid-v1", values.get("--tid-v1") as string)
    : undefined;
  const preImageFile = values.get("--pre-image");
  if (base.apply) {
    if (preImageFile === undefined) {
      throw new Error("--apply requires --pre-image <file>");
    }
    if (tidV2 !== undefined || tidV1 !== undefined) {
      throw new Error(
        "--apply evaluates against collection_whitelist; edit the table instead of passing --tid-v2/--tid-v1",
      );
    }
    if (flags.has("--exact-daily-history")) {
      throw new Error("--exact-daily-history only applies to a dry run");
    }
  } else if (preImageFile !== undefined) {
    throw new Error("--pre-image is only used with --apply");
  }

  const maxBatches = values.has("--max-batches")
    ? nonNegativeInteger("--max-batches", values.get("--max-batches") as string)
    : undefined;
  if (maxBatches === 0) throw new Error("--max-batches must be at least 1");

  return {
    ...base,
    activeOnly,
    aidsFile,
    all,
    allowLabelDemotion: flags.has("--allow-label-demotion"),
    allowPullLegacy: flags.has("--allow-pull-legacy"),
    detailsFile: values.get("--details"),
    exactDailyHistory: flags.has("--exact-daily-history"),
    fromAid,
    maxBatches,
    preImageFile,
    tidV1,
    tidV2,
    toAid,
  };
}

export type DecisionBasis = "label" | "v2" | "v1";

const ADMISSIONS = new Set([
  "upserted_bootstrap",
  "upserted_backfill_daily_only",
  "refreshed_from_daily",
]);
const NEW_ADMISSION_CLASS: Record<string, string> = {
  refreshed_from_daily: "newly_admit_daily",
  upserted_backfill_daily_only: "newly_admit_backfill",
  upserted_bootstrap: "newly_admit_bootstrap",
};

/**
 * Names what a decision means for the stored row. `decision` is the upsert's
 * outcome (a 'new_' prefix from fn_reevaluate_collection_whitelist is ignored),
 * `currentPriority` the state row's priority before the evaluation (null when
 * there is no row) and `basis` what decided: a complete label, a known tid_v2,
 * or the legacy type_id while tid_v2 is unknown.
 */
export function classifyCollectionOutcome(
  decision: string,
  currentPriority: number | null,
  basis: DecisionBasis,
): string {
  const raw = decision.replace(/^new_/, "");
  if (raw.startsWith("revived_")) return "revive";
  if (ADMISSIONS.has(raw)) {
    if (basis === "label") return "label_admit";
    if (currentPriority !== null) return "keep_active";
    if (basis === "v1") return "v2_unknown_v1_admit";
    return NEW_ADMISSION_CLASS[raw];
  }
  switch (raw) {
    case "disabled_deleted":
      return "disable_deleted";
    case "disabled_filtered_out":
      return "disable_filtered_out";
    case "ignored_deleted":
    case "ignored_filtered_out":
    case "ignored_label_demotion":
      return "no_row_not_admitted";
    case "ignored_existing_disabled":
      return "unchanged_disabled";
    case "disabled_label_demotion":
      return "label_demotion";
    case "disabled_not_whitelisted":
      return "pull_out";
    case "ignored_label_not_ready":
      return basis === "label" ? "label_not_ready" : "v2_unknown_no_v1";
    case "ignored_not_whitelisted":
      if (currentPriority === null) return "no_row_not_admitted";
      return currentPriority === -1 ? "unchanged_disabled" : "keep_active";
    default:
      return raw;
  }
}

/** Outcomes that change the row, or would without the protection. */
const LISTED_OUTCOMES = new Set([
  "pull_out",
  "label_demotion",
  "disable_deleted",
  "disable_filtered_out",
  "pull_out_blocked_protected",
  "label_demotion_blocked_protected",
  "newly_admit_bootstrap",
  "newly_admit_backfill",
  "newly_admit_daily",
  "v2_unknown_v1_admit",
  "revive",
]);

function isMonitored(row: VideoFacts): boolean {
  return row.currentPriority !== null && row.currentPriority > 0;
}

/** A row that leaves, enters, is held by the protection, or is monitored now. */
function isListed(row: VideoFacts): boolean {
  return (
    LISTED_OUTCOMES.has(row.outcome) ||
    (row.outcome === "label_admit" &&
      (row.currentPriority === null || row.currentPriority === -1)) ||
    isMonitored(row)
  );
}

function detailLine(row: VideoFacts): string {
  return detailValues(row).map(csvField).join(",");
}

interface VideoFacts {
  aid: number;
  tidV2: number | null;
  typeId: number | null;
  pidV2: number | null;
  labelContentType: string | null;
  labelOrigin: string | null;
  labeledBy: string | null;
  currentPriority: number | null;
  currentSource: string | null;
  basis: DecisionBasis;
  decision: string;
  outcome: string;
}

const DETAIL_COLUMNS = [
  "aid",
  "tid_v2",
  "type_id",
  "pid_v2",
  "label_content_type",
  "label_origin",
  "labeled_by",
  "current_priority",
  "current_monitor_source",
  "basis",
  "decision",
  "outcome",
] as const;

function detailValues(row: VideoFacts): unknown[] {
  return [
    row.aid,
    row.tidV2,
    row.typeId,
    row.pidV2,
    row.labelContentType,
    row.labelOrigin,
    row.labeledBy,
    row.currentPriority,
    row.currentSource,
    row.basis,
    row.decision,
    row.outcome,
  ];
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.split('"').join('""')}"` : text;
}

function priorityClass(priority: number | null): string {
  if (priority === null) return "none";
  return priority > 0 ? ">0" : String(priority);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

class Report {
  readonly outcomes = new Map<string, number>();
  readonly crossTab = new Map<string, number>();
  readonly byTid = new Map<string, number>();
  readonly byLabel = new Map<string, number>();
  videos = 0;

  add(row: VideoFacts): void {
    this.videos++;
    increment(this.outcomes, row.outcome);
    increment(
      this.crossTab,
      [
        row.outcome,
        priorityClass(row.currentPriority),
        row.currentSource ?? "NULL",
      ].join("\t"),
    );
    const tidGroup =
      row.tidV2 !== null && row.tidV2 > 0
        ? `tid_v2 ${row.tidV2}`
        : `type_id ${row.typeId ?? "NULL"} (tid_v2 ${row.tidV2 ?? "NULL"})`;
    increment(this.byTid, [tidGroup, row.outcome].join("\t"));
    increment(
      this.byLabel,
      [row.labelContentType ?? "NULL", row.outcome].join("\t"),
    );
  }
}

type Output = (line: string) => void;

function printTable(
  out: Output,
  title: string,
  header: string[],
  map: Map<string, number>,
): void {
  out("");
  out(`== ${title}`);
  const rows = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => [...key.split("\t"), String(count)]);
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );
  for (const row of all) {
    out(
      row
        .map((cell, column) =>
          column === row.length - 1
            ? cell.padStart(widths[column])
            : cell.padEnd(widths[column]),
        )
        .join("  "),
    );
  }
}

interface Selection {
  where: string;
  values: unknown[];
}

/**
 * The batch filter over `v` (processed_videos) and `s` (its state row).
 * $1 is the last aid of the previous batch (NULL for the first batch).
 */
function selection(
  options: CollectionReevaluationOptions,
  aids: number[] | undefined,
): Selection {
  const conditions = ["($1::bigint IS NULL OR v.aid > $1::bigint)"];
  const values: unknown[] = [];
  if (options.toAid !== undefined) {
    values.push(options.toAid);
    conditions.push(`v.aid <= $${values.length + 1}::bigint`);
  }
  if (aids !== undefined) {
    values.push(aids);
    conditions.push(`v.aid = ANY($${values.length + 1}::bigint[])`);
  }
  if (options.activeOnly) conditions.push("s.priority > 0");
  return { values, where: conditions.join(" AND ") };
}

function factsSql(
  sel: Selection,
  batchSize: number,
  decision:
    | {
        tidV2Param: number;
        tidV1Param: number;
        labelTypesParam: number;
        labelOriginParam: number;
        labelWritersParam: number;
        ageDaysParam: number;
        exactDailyHistory: boolean;
        allowPullLegacy: boolean;
        allowLabelDemotion: boolean;
      }
    | undefined,
): string {
  const label = completeFormalLabelSql("vj.row_json");
  const decisionColumn =
    decision === undefined
      ? "NULL::text"
      : collectionDecisionSql({
          allowLabelDemotion: String(decision.allowLabelDemotion),
          allowPullLegacy: String(decision.allowPullLegacy),
          ctime: "v.ctime",
          existingPriority: "s.priority",
          existingSource: "sj.state_json ->> 'monitor_source'",
          hasDailyHistory: decision.exactDailyHistory
            ? "(history.aid IS NOT NULL)"
            : "(s.last_daily_record_date IS NOT NULL)",
          incomingTidV2: "v.tid_v2",
          isDeleted: "COALESCE(v.is_deleted, false)",
          isFiltered: "v.is_filtered",
          labelContentType: label[0],
          labelOrigin: label[1],
          labeledBy: label[2],
          newVideoAgeDays: `$${decision.ageDaysParam}::integer`,
          now: "now()",
          passingLabelContentTypes: `$${decision.labelTypesParam}::text[]`,
          passingLabelOrigin: `$${decision.labelOriginParam}::text`,
          passingLabelWriters: `$${decision.labelWritersParam}::text[]`,
          pubdate: "v.pubdate",
          storedTidV2: "v.tid_v2",
          tidV1List: `$${decision.tidV1Param}::integer[]`,
          tidV2List: `$${decision.tidV2Param}::integer[]`,
          typeId: "v.type_id",
        });
  const history = decision?.exactDailyHistory
    ? `,
    history AS (
      SELECT DISTINCT d.aid FROM video_daily d
      WHERE d.aid IN (SELECT aid FROM batch)
    )`
    : "";
  const historyJoin = decision?.exactDailyHistory
    ? "LEFT JOIN history ON history.aid = v.aid"
    : "";
  return `
    WITH batch AS (
      SELECT v.aid
      FROM processed_videos v
      LEFT JOIN video_collection_state s ON s.aid = v.aid
      WHERE ${sel.where}
      ORDER BY v.aid
      LIMIT ${batchSize}
    )${history}
    SELECT
      v.aid,
      v.tid_v2,
      v.type_id,
      v.pid_v2,
      vj.row_json ->> 'label_content_type' AS label_content_type,
      vj.row_json ->> 'label_origin' AS label_origin,
      vj.row_json ->> 'labeled_by' AS labeled_by,
      s.priority AS current_priority,
      sj.state_json ->> 'monitor_source' AS current_source,
      CASE
        WHEN ${label[0]} IS NOT NULL THEN 'label'
        WHEN v.tid_v2 > 0 THEN 'v2'
        ELSE 'v1'
      END AS basis,
      ${decisionColumn} AS decision
    FROM batch
    JOIN processed_videos v ON v.aid = batch.aid
    CROSS JOIN LATERAL (SELECT to_jsonb(v) AS row_json) vj
    LEFT JOIN video_collection_state s ON s.aid = v.aid
    CROSS JOIN LATERAL (SELECT to_jsonb(s) AS state_json) sj
    ${historyJoin}
    ORDER BY v.aid
  `;
}

interface FactsRow {
  aid: string | number;
  tid_v2: number | null;
  type_id: number | null;
  pid_v2: number | null;
  label_content_type: string | null;
  label_origin: string | null;
  labeled_by: string | null;
  current_priority: number | null;
  current_source: string | null;
  basis: DecisionBasis;
  decision: string | null;
}

function toFacts(row: FactsRow, decision: string): VideoFacts {
  const currentPriority =
    row.current_priority === null ? null : Number(row.current_priority);
  return {
    aid: Number(row.aid),
    basis: row.basis,
    currentPriority,
    currentSource: row.current_source,
    decision,
    labelContentType: row.label_content_type,
    labeledBy: row.labeled_by,
    labelOrigin: row.label_origin,
    outcome: classifyCollectionOutcome(decision, currentPriority, row.basis),
    pidV2: row.pid_v2,
    tidV2: row.tid_v2,
    typeId: row.type_id,
  };
}

async function setLocal(
  client: PoolClient,
  name: string,
  value: string,
): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [name, value]);
}

async function readAidsFile(path: string): Promise<number[]> {
  const text = await readFile(path, "utf8");
  const aids = text
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .map((entry) => nonNegativeInteger("--aids-file entry", entry));
  return [...new Set(aids)].sort((a, b) => a - b);
}

async function resolveLists(
  client: PoolClient,
  options: CollectionReevaluationOptions,
): Promise<{ tidV2: number[]; tidV1: number[]; source: string }> {
  if (options.tidV2 !== undefined && options.tidV1 !== undefined) {
    return {
      source: "arguments",
      tidV1: options.tidV1,
      tidV2: options.tidV2,
    };
  }
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('collection_whitelist') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) {
    throw new Error(
      "collection_whitelist does not exist in this database; pass --tid-v2 and --tid-v1",
    );
  }
  const rows = await client.query<{ kind: string; value: number }>(
    "SELECT kind, value FROM collection_whitelist WHERE kind IN ('tid_v2', 'tid_v1') ORDER BY kind, value",
  );
  const fromTable = (kind: string) =>
    rows.rows.filter((row) => row.kind === kind).map((row) => row.value);
  return {
    source:
      options.tidV2 === undefined && options.tidV1 === undefined
        ? "collection_whitelist"
        : "arguments and collection_whitelist",
    tidV1: options.tidV1 ?? fromTable("tid_v1"),
    tidV2: options.tidV2 ?? fromTable("tid_v2"),
  };
}

function describeRange(
  options: CollectionReevaluationOptions,
  aids: number[] | undefined,
): string {
  const parts: string[] = [];
  if (options.all) parts.push("all stored videos");
  if (options.activeOnly) parts.push("state priority > 0");
  if (aids !== undefined)
    parts.push(`${aids.length} aids from ${options.aidsFile}`);
  if (options.fromAid !== undefined) parts.push(`aid >= ${options.fromAid}`);
  if (options.toAid !== undefined) parts.push(`aid <= ${options.toAid}`);
  return parts.join(", ");
}

function printReport(out: Output, report: Report): void {
  out("");
  out(`videos evaluated: ${report.videos}`);
  printTable(out, "outcome", ["outcome", "videos"], report.outcomes);
  const leaving =
    (report.outcomes.get("pull_out") ?? 0) +
    (report.outcomes.get("label_demotion") ?? 0);
  out(`leaving minute monitoring (pull_out + label_demotion): ${leaving}`);
  printTable(
    out,
    "outcome x current priority x current monitor_source",
    ["outcome", "priority", "monitor_source", "videos"],
    report.crossTab,
  );
  printTable(
    out,
    "by tid_v2 (by type_id while tid_v2 is 0 or NULL)",
    ["group", "outcome", "videos"],
    report.byTid,
  );
  printTable(
    out,
    "by label_content_type",
    ["label_content_type", "outcome", "videos"],
    report.byLabel,
  );
}

async function runEvaluation(
  pool: Pool,
  options: CollectionReevaluationOptions,
  out: Output,
): Promise<void> {
  const aids =
    options.aidsFile === undefined
      ? undefined
      : await readAidsFile(options.aidsFile);
  const sel = selection(options, aids);
  const minute = config.whitelist.minuteBootstrap;
  const report = new Report();
  const client = await pool.connect();
  const preImage =
    options.apply && options.preImageFile !== undefined
      ? await open(options.preImageFile, "a")
      : undefined;
  const details =
    options.detailsFile === undefined
      ? undefined
      : await open(options.detailsFile, "w");
  try {
    out(
      `mode: ${options.apply ? "APPLY (writes video_collection_state)" : "dry run (read-only, writes nothing)"}`,
    );
    out(`range: ${describeRange(options, aids)}`);
    out(
      `release: allow_pull_legacy=${options.allowPullLegacy} allow_label_demotion=${options.allowLabelDemotion}`,
    );

    let listParams: unknown[] = [];
    if (!options.apply) {
      await client.query("BEGIN TRANSACTION READ ONLY");
      try {
        const lists = await resolveLists(client, options);
        listParams = [
          lists.tidV2,
          lists.tidV1,
          minute.labelContentTypes,
          minute.labelOrigin,
          minute.labelWriters,
          config.minute.processedBackfillNewVideoAgeDays,
        ];
        out(`lists (${lists.source}): tid_v2=[${lists.tidV2.join(",")}]`);
        out(`  tid_v1=[${lists.tidV1.join(",")}]`);
        out(
          `labels: content_types=[${minute.labelContentTypes.join(",")}] origin=${minute.labelOrigin} writers=[${minute.labelWriters.join(",")}]`,
        );
        out(
          `new video age: ${config.minute.processedBackfillNewVideoAgeDays} days`,
        );
        out(
          options.exactDailyHistory
            ? "daily history: exact (video_daily per batch)"
            : "daily history: APPROXIMATE (state row has last_daily_record_date)",
        );
      } finally {
        await client.query("ROLLBACK");
      }
    } else {
      const ready = await client.query<{ ready: boolean }>(
        "SELECT to_regprocedure('fn_reevaluate_collection_whitelist(bigint[])') IS NOT NULL AS ready",
      );
      if (ready.rows[0]?.ready !== true) {
        throw new Error(
          "fn_reevaluate_collection_whitelist is not installed; run init-schema first",
        );
      }
      out(`pre-image file: ${options.preImageFile}`);
    }

    const base = sel.values.length + 1;
    const sql = factsSql(
      sel,
      options.batchSize,
      options.apply
        ? undefined
        : {
            ageDaysParam: base + 6,
            allowLabelDemotion: options.allowLabelDemotion,
            allowPullLegacy: options.allowPullLegacy,
            exactDailyHistory: options.exactDailyHistory,
            labelOriginParam: base + 4,
            labelTypesParam: base + 3,
            labelWritersParam: base + 5,
            tidV1Param: base + 2,
            tidV2Param: base + 1,
          },
    );

    // Every evaluated row goes to the details file. The terminal lists the
    // monitored rows, and without a details file also every row that leaves,
    // enters or is held by the protection.
    await details?.appendFile(`${DETAIL_COLUMNS.join(",")}\n`);
    out("");
    out(
      details === undefined
        ? "== videos that leave, enter or are protected, and every video with priority > 0"
        : `== videos with priority > 0 (every evaluated video: ${options.detailsFile})`,
    );
    out(DETAIL_COLUMNS.join(","));

    let lastAid: number | null =
      options.fromAid === undefined ? null : options.fromAid - 1;
    let batches = 0;
    let finished = false;
    while (options.maxBatches === undefined || batches < options.maxBatches) {
      const rows = options.apply
        ? await applyBatch(client, options, sql, [lastAid, ...sel.values])
        : await dryRunBatch(client, options, sql, [
            lastAid,
            ...sel.values,
            ...listParams,
          ]);
      if (rows.length === 0) {
        finished = true;
        break;
      }
      batches++;
      for (const row of rows) {
        report.add(row);
        if (details === undefined ? isListed(row) : isMonitored(row)) {
          out(detailLine(row));
        }
      }
      await details?.appendFile(
        rows.map((row) => `${detailLine(row)}\n`).join(""),
      );
      lastAid = rows[rows.length - 1].aid;
      out(
        `# batch ${batches}: aids ${rows[0].aid}..${lastAid}, ${rows.length} videos; next --from-aid ${lastAid + 1}`,
      );
      if (rows.length < options.batchSize) {
        finished = true;
        break;
      }
    }

    printReport(out, report);
    out("");
    out(
      finished
        ? "range complete"
        : `stopped after ${batches} batch(es); resume with --from-aid ${(lastAid ?? -1) + 1}`,
    );
  } finally {
    await preImage?.close();
    await details?.close();
    client.release();
  }

  async function dryRunBatch(
    db: PoolClient,
    opts: CollectionReevaluationOptions,
    query: string,
    params: unknown[],
  ): Promise<VideoFacts[]> {
    await db.query("BEGIN TRANSACTION READ ONLY");
    try {
      await setLocal(db, "statement_timeout", opts.statementTimeout);
      const result = await db.query<FactsRow>(query, params);
      return result.rows.map((row) => toFacts(row, row.decision as string));
    } finally {
      await db.query("ROLLBACK");
    }
  }

  async function applyBatch(
    db: PoolClient,
    opts: CollectionReevaluationOptions,
    query: string,
    params: unknown[],
  ): Promise<VideoFacts[]> {
    await db.query("BEGIN");
    try {
      await setLocal(db, "statement_timeout", opts.statementTimeout);
      await setLocal(db, "lock_timeout", opts.lockTimeout);
      if (opts.allowPullLegacy) {
        await setLocal(
          db,
          COLLECTION_PROTECTION_RELEASE_SETTINGS.pullLegacy,
          "on",
        );
      }
      if (opts.allowLabelDemotion) {
        await setLocal(
          db,
          COLLECTION_PROTECTION_RELEASE_SETTINGS.labelDemotion,
          "on",
        );
      }

      const facts = (await db.query<FactsRow>(query, params)).rows;
      if (facts.length === 0) {
        await db.query("COMMIT");
        return [];
      }
      const batchAids = facts.map((row) => Number(row.aid));

      // Lock the state rows and keep their full rows, as text so no value
      // loses precision, before anything is written.
      const locked = await db.query<{
        aid: string;
        priority: number;
        source: string | null;
        state: string;
      }>(
        `SELECT s.aid, s.priority, to_jsonb(s) ->> 'monitor_source' AS source,
                to_jsonb(s)::text AS state
         FROM video_collection_state s
         WHERE s.aid = ANY($1::bigint[])
         ORDER BY s.aid
         FOR UPDATE`,
        [batchAids],
      );
      const states = new Map(locked.rows.map((row) => [Number(row.aid), row]));
      for (const row of facts) {
        const state = states.get(Number(row.aid));
        row.current_priority = state === undefined ? null : state.priority;
        row.current_source = state?.source ?? null;
      }
      await preImage?.appendFile(
        batchAids
          .map((aid) => preImageLine(aid, states.get(aid)?.state ?? null))
          .join(""),
      );
      await preImage?.sync();

      const evaluated = await db.query<{ aid: string; outcome: string }>(
        `SELECT b.aid, r.outcome
         FROM unnest($1::bigint[]) WITH ORDINALITY AS b(aid, position)
         CROSS JOIN LATERAL fn_reevaluate_collection_whitelist(ARRAY[b.aid]) AS r
         ORDER BY b.position`,
        [batchAids],
      );
      const outcomes = new Map(
        evaluated.rows.map((row) => [Number(row.aid), row.outcome]),
      );
      await db.query("COMMIT");
      return facts.map((row) =>
        toFacts(row, outcomes.get(Number(row.aid)) ?? "video_missing"),
      );
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
}

/**
 * One pre-image line: the aid and the state row exactly as to_jsonb(row)::text
 * printed it, or null when the video had no state row.
 */
function preImageLine(aid: number, stateJson: string | null): string {
  return `{"aid":${aid},"row":${stateJson ?? "null"}}\n`;
}

interface PreImageEntry {
  aid: number;
  /** The row's JSON text, passed back to the database unparsed. */
  row: string | null;
}

async function readPreImage(path: string): Promise<PreImageEntry[]> {
  const text = await readFile(path, "utf8");
  // An aid can appear more than once when runs overlapped; its first entry is
  // the state before any of them.
  const first = new Map<number, PreImageEntry>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const match = /^\{"aid":(\d+),"row":(.*)\}$/.exec(line);
    if (match === null) {
      throw new Error(`${path}:${index + 1} is not a pre-image line`);
    }
    const aid = Number(match[1]);
    const row = match[2] === "null" ? null : match[2];
    if (!first.has(aid)) first.set(aid, { aid, row });
  }
  return [...first.values()].sort((a, b) => a.aid - b.aid);
}

/** Puts back the state rows recorded in a pre-image file. */
async function runRestore(
  pool: Pool,
  options: CollectionReevaluationOptions,
  out: Output,
): Promise<void> {
  const entries = await readPreImage(options.restoreFile as string);
  const client = await pool.connect();
  const counts = { deleted: 0, restored: 0, unchanged: 0 };
  try {
    out(
      `mode: ${options.apply ? "APPLY restore (writes video_collection_state)" : "restore preview (read-only, writes nothing)"}`,
    );
    out(`pre-image: ${options.restoreFile} (${entries.length} videos)`);
    const columns = (
      await client.query<{ name: string }>(
        `SELECT attname AS name FROM pg_attribute
         WHERE attrelid = 'video_collection_state'::regclass
           AND attnum > 0 AND NOT attisdropped AND attname <> 'aid'
         ORDER BY attnum`,
      )
    ).rows.map((row) => `"${row.name.split('"').join('""')}"`);
    const restoreSql = `
      UPDATE video_collection_state AS target
      SET (${columns.join(", ")}) = (
        SELECT ${columns.map((column) => `r.${column}`).join(", ")}
        FROM jsonb_populate_record(NULL::video_collection_state, $2::jsonb) AS r
      )
      WHERE target.aid = $1::bigint`;

    for (let start = 0; start < entries.length; start += options.batchSize) {
      const batch = entries.slice(start, start + options.batchSize);
      const aids = batch.map((entry) => entry.aid);
      await client.query(
        options.apply ? "BEGIN" : "BEGIN TRANSACTION READ ONLY",
      );
      try {
        await setLocal(client, "statement_timeout", options.statementTimeout);
        if (options.apply) {
          await setLocal(client, "lock_timeout", options.lockTimeout);
        }
        const current = await client.query<{ aid: string; state: unknown }>(
          `SELECT s.aid, to_jsonb(s) AS state
           FROM video_collection_state s
           WHERE s.aid = ANY($1::bigint[])
           ORDER BY s.aid${options.apply ? " FOR UPDATE" : ""}`,
          [aids],
        );
        const present = new Set(current.rows.map((row) => Number(row.aid)));
        for (const entry of batch) {
          if (entry.row === null) {
            if (!present.has(entry.aid)) {
              counts.unchanged++;
              continue;
            }
            counts.deleted++;
            if (options.apply) {
              await client.query(
                "DELETE FROM video_collection_state WHERE aid = $1::bigint",
                [entry.aid],
              );
            }
            continue;
          }
          const same = present.has(entry.aid)
            ? (
                await client.query<{ same: boolean }>(
                  "SELECT to_jsonb(s) = $2::jsonb AS same FROM video_collection_state s WHERE s.aid = $1::bigint",
                  [entry.aid, entry.row],
                )
              ).rows[0]?.same === true
            : false;
          if (same) {
            counts.unchanged++;
            continue;
          }
          counts.restored++;
          if (!options.apply) continue;
          if (present.has(entry.aid)) {
            await client.query(restoreSql, [entry.aid, entry.row]);
          } else {
            await client.query(
              `INSERT INTO video_collection_state
               SELECT * FROM jsonb_populate_record(NULL::video_collection_state, $1::jsonb)`,
              [entry.row],
            );
          }
        }
        await client.query(options.apply ? "COMMIT" : "ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      out(
        `batch ending at aid ${aids[aids.length - 1]}: restored ${counts.restored}, deleted ${counts.deleted}, unchanged ${counts.unchanged} so far`,
      );
    }
    out(
      `${options.apply ? "restored" : "would restore"} ${counts.restored}, ${options.apply ? "deleted" : "would delete"} ${counts.deleted}, unchanged ${counts.unchanged}`,
    );
  } finally {
    client.release();
  }
}

export async function runCollectionReevaluation(
  pool: Pool,
  options: CollectionReevaluationOptions,
  out: Output = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  if (options.restoreFile !== undefined) {
    await runRestore(pool, options, out);
  } else {
    await runEvaluation(pool, options, out);
  }
}
