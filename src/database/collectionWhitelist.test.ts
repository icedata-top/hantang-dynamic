import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { config } from "../config/index.js";
import { getCollectionWhitelist } from "./collectionWhitelist.js";
import { initCollectionStateSchema } from "./schema/collection_state.js";
import { initCollectionWhitelistSchema } from "./schema/collection_whitelist.js";
import { initializeSchema } from "./schema/index.js";

interface Call {
  sql: string;
  values?: unknown[];
}

function createPool(options: { tableExists: boolean }) {
  const calls: Call[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("to_regclass('collection_whitelist')")) {
      return { rows: [{ present: options.tableExists }], rowCount: 1 };
    }
    if (sql.includes("FROM pg_extension")) {
      return { rows: [{ installed: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    calls,
  };
}

async function withSeedConfig<T>(
  seeds: { typeIds?: number[]; tidV2: number[]; pidV2: number[] },
  run: () => Promise<T>,
): Promise<T> {
  const originalTypeIds = config.whitelist.video.typeIds;
  const originalTid = config.whitelist.minuteBootstrap.tidV2;
  const originalPid = config.whitelist.recommendation.pidV2;
  config.whitelist.video.typeIds = seeds.typeIds ?? [];
  config.whitelist.minuteBootstrap.tidV2 = seeds.tidV2;
  config.whitelist.recommendation.pidV2 = seeds.pidV2;
  try {
    return await run();
  } finally {
    config.whitelist.video.typeIds = originalTypeIds;
    config.whitelist.minuteBootstrap.tidV2 = originalTid;
    config.whitelist.recommendation.pidV2 = originalPid;
  }
}

function inserts(calls: Call[]): unknown[][] {
  return calls
    .filter((call) => call.sql.includes("INSERT INTO collection_whitelist"))
    .map((call) => call.values ?? []);
}

test("a newly created whitelist is seeded once from the legacy config values", async () => {
  const { pool, calls } = createPool({ tableExists: false });

  await withSeedConfig(
    { typeIds: [28, 30], tidV2: [2022, 2061], pidV2: [7] },
    () => initCollectionWhitelistSchema(pool),
  );

  assert.deepEqual(inserts(calls), [
    ["tid_v1", 28],
    ["tid_v1", 30],
    ["tid_v2", 2022],
    ["tid_v2", 2061],
    ["pid_v2", 7],
  ]);
  const sql = calls.map((call) => call.sql).join("\n");
  assert.match(sql, /CHECK \(kind IN \('tid_v1', 'tid_v2', 'pid_v2'\)\)/);
  assert.match(sql, /PRIMARY KEY \(kind, value\)/);
});

test("an empty type list seeds no legacy tid_v1 rows", async () => {
  const { pool, calls } = createPool({ tableExists: false });

  await withSeedConfig({ typeIds: [], tidV2: [2022], pidV2: [] }, () =>
    initCollectionWhitelistSchema(pool),
  );

  assert.deepEqual(inserts(calls), [["tid_v2", 2022]]);
});

test("an existing whitelist is never re-seeded, so removed values stay removed", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await withSeedConfig(
    { typeIds: [28, 30], tidV2: [2022, 2061], pidV2: [7] },
    () => initCollectionWhitelistSchema(pool),
  );

  assert.deepEqual(inserts(calls), []);
  assert.ok(
    calls.some((call) => call.sql.includes("fn_collection_whitelist_match")),
    "the match function is still (re)installed",
  );
});

test("the match function qualifies a video by tid_v2 or by pid_v2", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionWhitelistSchema(pool);

  const sql =
    calls.find((call) => call.sql.includes("fn_collection_whitelist_match"))
      ?.sql ?? "";
  assert.match(sql, /kind = 'tid_v2' AND value = p_tid_v2/);
  assert.match(sql, /kind = 'pid_v2' AND value = p_pid_v2/);
  assert.match(sql, /\bOR\b/);
});

test("the legacy tid whitelist is a separate kind matched on type_id", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionWhitelistSchema(pool);

  const sql =
    calls.find((call) => call.sql.includes("fn_collection_whitelist_match_v1"))
      ?.sql ?? "";
  assert.match(sql, /kind = 'tid_v1' AND value = p_type_id/);
  const v2 =
    calls.find((call) =>
      call.sql.includes(
        "CREATE OR REPLACE FUNCTION fn_collection_whitelist_match(",
      ),
    )?.sql ?? "";
  assert.doesNotMatch(v2, /tid_v1/, "v1 never counts toward the v2 verdict");
  assert.ok(
    calls.some((call) =>
      call.sql.includes(
        "DROP CONSTRAINT IF EXISTS chk_collection_whitelist_kind",
      ),
    ),
    "a table created before tid_v1 existed is widened",
  );
});

test("whitelist lookup reads one kind in a stable order", async () => {
  const calls: Call[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ value: 2022 }, { value: "2061" }], rowCount: 2 };
    },
  } as unknown as Pool;

  const values = await getCollectionWhitelist(pool, "tid_v2");

  assert.deepEqual(values, [2022, 2061]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /WHERE kind = \$1 ORDER BY value/);
  assert.deepEqual(calls[0]?.values, ["tid_v2"]);
});

test("processed_videos trigger keeps monitoring in step with type_id, tid_v2, pid_v2 and filter state", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionStateSchema(pool);

  const sql = calls.map((call) => call.sql).join("\n");
  assert.match(
    sql,
    /CREATE TRIGGER trg_processed_video_collection_state\s+AFTER INSERT ON processed_videos/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER trg_processed_video_collection_state_update\s+AFTER UPDATE OF aid, type_id, tid_v2, pid_v2, is_filtered, is_deleted\s+ON processed_videos/,
  );
  for (const column of [
    "aid",
    "type_id",
    "tid_v2",
    "pid_v2",
    "is_filtered",
    "is_deleted",
  ]) {
    assert.match(
      sql,
      new RegExp(`OLD\\.${column} IS DISTINCT FROM NEW\\.${column}`),
    );
  }
});

test("trigger and re-evaluation call the upsert with nine arguments to avoid the ten-argument wrapper", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionStateSchema(pool);

  const trigger =
    calls.find((call) =>
      call.sql.includes(
        "CREATE OR REPLACE FUNCTION fn_processed_video_collection_state",
      ),
    )?.sql ?? "";
  const reevaluate =
    calls.find((call) =>
      call.sql.includes(
        "CREATE OR REPLACE FUNCTION fn_reevaluate_collection_whitelist",
      ),
    )?.sql ?? "";
  for (const sql of [trigger, reevaluate]) {
    const call = sql.slice(
      sql.indexOf("fn_upsert_collection_state_from_processed_video("),
    );
    const args = call.slice(call.indexOf("(") + 1, call.indexOf(")\n"));
    assert.equal(
      args.split(",\n").length,
      9,
      `expected nine arguments in:\n${sql}`,
    );
  }
  assert.match(reevaluate, /p_aids bigint\[\] DEFAULT NULL/);
});

test("the upsert drags non-whitelisted videos out, protects label and manual rows, and only revives whitelist exclusions", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionStateSchema(pool);

  const sql = calls.map((call) => call.sql).join("\n");
  // A -1 row is final unless the whitelist itself excluded it.
  assert.match(
    sql,
    /existing_priority = -1\s+AND existing_source IS DISTINCT FROM 'whitelist_excluded'/,
  );
  // Demotion needs a tid_v2/pid_v2 to judge, never touches label rows, and is reversible.
  assert.match(
    sql,
    /v2_known := effective_tid IS NOT NULL OR stored_pid IS NOT NULL/,
  );
  assert.match(
    sql,
    /existing_priority <> -1\s+AND COALESCE\(existing_source, ''\) NOT IN \('label', 'manual'\)/,
  );
  assert.match(sql, /monitor_source = 'whitelist_excluded'/);
  assert.match(sql, /RETURN 'disabled_not_whitelisted'/);
  // A missing caller tid_v2 falls back to the stored one.
  assert.match(sql, /effective_tid := COALESCE\(p_tid_v2, stored_tid\)/);
  // The static allowlist argument no longer decides anything.
  assert.doesNotMatch(sql, /p_tid_v2 = ANY\(p_bootstrap_tid_v2_allowlist\)/);
  // monitor_source is constrained to the known values.
  assert.match(
    sql,
    /monitor_source IN \(\s*'label', 'whitelist', 'whitelist_excluded', 'manual', 'daily'\s*\)/,
  );
});

test("schema initialization creates the whitelist table before the collection state functions use it", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initializeSchema(pool, "public");

  const whitelist = calls.findIndex((call) =>
    call.sql.includes("CREATE TABLE IF NOT EXISTS collection_whitelist"),
  );
  const trigger = calls.findIndex((call) =>
    call.sql.includes("CREATE TRIGGER trg_processed_video_collection_state"),
  );
  assert.ok(whitelist >= 0, "whitelist table is created");
  assert.ok(trigger >= 0, "processed_videos trigger is created");
  assert.ok(whitelist < trigger);
});

test("v1 type_id only stands in until a tid_v2 or pid_v2 is known, and never demotes", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionStateSchema(pool);

  const sql = calls.map((call) => call.sql).join("\n");
  assert.match(
    sql,
    /WHEN v2_known THEN fn_collection_whitelist_match\(effective_tid, stored_pid\)\s+ELSE fn_collection_whitelist_match_v1\(stored_type\)/,
  );
  // Demotion is gated on v2 being known, so a v1 mismatch cannot reach it.
  assert.match(sql, /IF NOT has_formal_label_input AND v2_known THEN/);
});

test("rows inserted by hand are manual, and the codebase's own inserts name their source", async () => {
  const { pool, calls } = createPool({ tableExists: true });

  await initCollectionStateSchema(pool);

  const sql = calls.map((call) => call.sql).join("\n");
  assert.match(sql, /ALTER COLUMN monitor_source SET DEFAULT 'manual'/);
  // The default is set after the column exists, so it never relabels old rows.
  assert.ok(
    sql.indexOf("ADD COLUMN IF NOT EXISTS monitor_source text") <
      sql.indexOf("ALTER COLUMN monitor_source SET DEFAULT 'manual'"),
  );
  // The daily refresh is a code insert and must not be mistaken for a manual one.
  assert.match(
    sql,
    /next_gate_value, subtitle_state, monitor_source, updated_at[\s\S]*?fn_next_subtitle_state\(NULL, c\.last_view, c\.crossed_gate\),\s+'daily',/,
  );
  // Label and manual markers survive later whitelist upserts.
  assert.match(
    sql,
    /video_collection_state\.monitor_source IN \('label', 'manual'\)\s+THEN video_collection_state\.monitor_source/,
  );
});
