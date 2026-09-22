import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { upsertPidV2Names } from "./pidV2Names";

test("PID V2 name upsert keeps the latest valid name for duplicate IDs", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const written = await upsertPidV2Names(pool, [
    { pidV2: 1001, name: "first name" },
    { pidV2: 1001, name: " final name " },
    { pidV2: 1002, name: "  " },
    { pidV2: 0, name: "invalid" },
  ]);

  assert.equal(written, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.values, [[1001], ["final name"]]);
  assert.match(calls[1]?.sql ?? "", /ON CONFLICT \(pid_v2\) DO UPDATE/);
  assert.match(
    calls[1]?.sql ?? "",
    /pid_v2_names\.name IS DISTINCT FROM EXCLUDED\.name/,
  );
});

test("PID V2 name cache skips writes for pairs already stored in the dictionary", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ pid_v2: 1001, name: "known name" }], rowCount: 0 };
    },
  } as unknown as Pool;

  assert.equal(
    await upsertPidV2Names(pool, [{ pidV2: 1001, name: " known name " }]),
    0,
  );
  assert.equal(
    await upsertPidV2Names(pool, [{ pidV2: 1001, name: "known name" }]),
    0,
  );
  assert.equal(calls.length, 1);
});

test("PID V2 name cache writes only new and changed dictionary pairs", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT")) {
        return { rows: [{ pid_v2: 1001, name: "old name" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 2 };
    },
  } as unknown as Pool;

  assert.equal(
    await upsertPidV2Names(pool, [
      { pidV2: 1001, name: "new name" },
      { pidV2: 1002, name: "unchanged name" },
    ]),
    2,
  );
  assert.deepEqual(calls[1]?.values, [
    [1001, 1002],
    ["new name", "unchanged name"],
  ]);
});

test("concurrent PID V2 name writes share the cache and persist once", async () => {
  let reads = 0;
  let writes = 0;
  const pool = {
    async query(sql: string) {
      if (sql.startsWith("SELECT")) {
        reads += 1;
        return { rows: [], rowCount: 0 };
      }
      writes += 1;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      upsertPidV2Names(pool, [{ pidV2: 1001, name: "shared name" }]),
    ),
  );

  assert.deepEqual(results, [1, ...Array<number>(19).fill(0)]);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test("PID V2 name cache retries after a failed load or write", async () => {
  let loadAttempts = 0;
  let writeAttempts = 0;
  const pool = {
    async query(sql: string) {
      if (sql.startsWith("SELECT")) {
        loadAttempts += 1;
        if (loadAttempts === 1) throw new Error("load failed");
        return { rows: [], rowCount: 0 };
      }
      writeAttempts += 1;
      if (writeAttempts === 1) throw new Error("write failed");
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  await assert.rejects(
    upsertPidV2Names(pool, [{ pidV2: 1001, name: "retry" }]),
  );
  await assert.rejects(
    upsertPidV2Names(pool, [{ pidV2: 1001, name: "retry" }]),
  );
  assert.equal(
    await upsertPidV2Names(pool, [{ pidV2: 1001, name: "retry" }]),
    1,
  );
  assert.equal(loadAttempts, 2);
  assert.equal(writeAttempts, 2);
});
