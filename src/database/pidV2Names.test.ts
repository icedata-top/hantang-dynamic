import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { upsertPidV2Names } from "./pidV2Names";

test("PID V2 name upsert keeps the latest valid name for duplicate IDs", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
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
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values, [[1001], ["final name"]]);
  assert.match(calls[0]?.sql ?? "", /ON CONFLICT \(pid_v2\) DO UPDATE/);
  assert.match(
    calls[0]?.sql ?? "",
    /pid_v2_names\.name IS DISTINCT FROM EXCLUDED\.name/,
  );
});
