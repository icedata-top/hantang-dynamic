import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "mysql2/promise";
import type { PoolClient } from "pg";
import { backfillVideoDaily } from "./manualVideoDaily";

type Row = { record_date: string; aid: string; coin: number };
const row = (date: string, aid: string, coin = 1): Row => ({
  record_date: date,
  aid,
  coin,
});
const key = (r: Row) => `${r.record_date}/${r.aid}`;
const compare = (a: Row, b: Row) =>
  BigInt(a.aid) < BigInt(b.aid)
    ? -1
    : BigInt(a.aid) > BigInt(b.aid)
      ? 1
      : a.record_date.localeCompare(b.record_date);

function fixture(
  initialSource: Row[],
  initialTarget: Row[],
  chunkExists = true,
  splitChunks = false,
) {
  let sourceRows = [...initialSource];
  let targetRows = [...initialTarget];
  let batch: Row[] = [];
  let snapshot: Row[] | undefined;
  let exists = chunkExists;
  let failInsert = false;
  let failDelete = false;
  let failCompression = false;
  let compressions = 0;
  const insertedBatches: string[][] = [];
  const source = {
    async query(_sql: string, args: string[]) {
      const [from, through, after] = args;
      const aids = [
        ...new Set(
          sourceRows
            .filter(
              (r) =>
                r.record_date >= from &&
                r.record_date <= through &&
                BigInt(r.aid) > BigInt(after),
            )
            .sort(compare)
            .map((r) => r.aid),
        ),
      ];
      return [aids.slice(0, 1).map((aid) => ({ aid }))];
    },
    async execute(sql: string, args: string[]) {
      if (sql.startsWith("DELETE")) {
        if (failDelete) throw new Error("delete failed");
        const keys = new Set<string>();
        for (let i = 0; i < args.length; i += 2) {
          assert.ok(
            targetRows.some((r) => key(r) === `${args[i]}/${args[i + 1]}`),
          );
          assert.ok(args[i] < "2026-04-18");
          keys.add(`${args[i]}/${args[i + 1]}`);
        }
        sourceRows = sourceRows.filter((r) => !keys.has(key(r)));
        return [{ affectedRows: keys.size }];
      }
      const [from, through, after, last, cursorAid, cursorDate] = args;
      let rows = sourceRows.filter(
        (r) => r.record_date >= from && r.record_date <= through,
      );
      if (sql.includes("ORDER BY record_date,aid")) {
        return [
          [...rows]
            .sort(
              (a, b) =>
                a.record_date.localeCompare(b.record_date) || compare(a, b),
            )
            .slice(0, 1),
        ];
      }
      rows = rows.filter(
        (r) =>
          BigInt(r.aid) > BigInt(after) &&
          BigInt(r.aid) <= BigInt(last) &&
          (BigInt(r.aid) > BigInt(cursorAid) ||
            (r.aid === cursorAid && r.record_date > cursorDate)),
      );
      const page = rows.sort(compare).slice(0, 1000);
      return [
        sql.startsWith("SELECT `record_date`,`aid` FROM")
          ? page.map(({ record_date, aid }) => ({ record_date, aid }))
          : page,
      ];
    },
  } as unknown as Pick<Connection, "execute" | "query">;
  const pg = {
    async query(sql: string, args: string[] = []) {
      if (sql.startsWith("TRUNCATE")) batch = [];
      if (sql.startsWith("INSERT INTO pg_temp")) {
        const width = sql.includes('("record_date","aid") VALUES') ? 2 : 9;
        for (let i = 0; i < args.length; i += width)
          batch.push(
            row(args[i], args[i + 1], width === 2 ? 1 : Number(args[i + 2])),
          );
      }
      if (sql.startsWith("SELECT b.record_date")) {
        const [today, date, aid, from, through, firstAid, lastAid] = args;
        assert.match(
          sql,
          /t\.record_date >= \$4::date AND t\.record_date <= \$5::date AND t\.aid >= \$6::bigint AND t\.aid <= \$7::bigint/,
        );
        for (const r of batch) {
          assert.ok(r.record_date >= from && r.record_date <= through);
          assert.ok(
            BigInt(r.aid) >= BigInt(firstAid) &&
              BigInt(r.aid) <= BigInt(lastAid),
          );
        }
        return {
          rows: batch
            .filter(
              (r) =>
                r.record_date < today &&
                (r.record_date > date ||
                  (r.record_date === date && BigInt(r.aid) > BigInt(aid))) &&
                targetRows.some((t) => key(t) === key(r)),
            )
            .sort(
              (a, b) =>
                a.record_date.localeCompare(b.record_date) || compare(a, b),
            )
            .slice(0, 1000),
        };
      }
      if (sql.includes("FROM timescaledb_information.chunks"))
        return {
          rows: exists
            ? [
                {
                  name:
                    splitChunks && args[1] > "2026-04-16"
                      ? "second_chunk"
                      : "chunk",
                  is_compressed: chunkExists,
                  finish:
                    splitChunks && args[1] <= "2026-04-16"
                      ? "2026-04-16"
                      : "2026-04-30",
                },
              ]
            : [],
        };
      if (sql === "BEGIN") snapshot = [...targetRows];
      if (sql === "ROLLBACK") {
        targetRows = snapshot ?? targetRows;
        snapshot = undefined;
      }
      if (sql === "COMMIT") snapshot = undefined;
      if (sql.startsWith('INSERT INTO "hantang_dynamic"')) {
        if (failInsert) throw new Error("insert failed");
        const candidates = sql.includes("FROM pg_temp")
          ? batch
          : [row(args[0], args[1], Number(args[2]))];
        if (sql.includes("FROM pg_temp")) {
          assert.match(
            sql,
            /t\.record_date >= \$1::date AND t\.record_date <= \$2::date AND t\.aid > \$3::bigint AND t\.aid <= \$4::bigint/,
          );
          for (const r of batch) {
            assert.ok(r.record_date >= args[0] && r.record_date <= args[1]);
            assert.ok(
              BigInt(r.aid) > BigInt(args[2]) &&
                BigInt(r.aid) <= BigInt(args[3]),
            );
          }
        }
        const missing = candidates.filter(
          (r) => !targetRows.some((t) => key(t) === key(r)),
        );
        insertedBatches.push(missing.map(key));
        targetRows.push(...missing);
        exists = true;
        return { rows: [], rowCount: missing.length };
      }
      if (sql.startsWith("CALL convert_to_columnstore")) {
        if (failCompression) throw new Error("compression failed");
        compressions++;
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return {
    run: () =>
      backfillVideoDaily(pg, source, {
        startDate: "2026-04-16",
        endDate: "2026-04-18",
        schema: "hantang_dynamic",
        today: "2026-04-18",
        size: 1,
      }),
    source: () => sourceRows,
    target: () => targetRows,
    batches: () => insertedBatches,
    compressions: () => compressions,
    failCompression: () => {
      failCompression = true;
    },
    failInsert: () => {
      failInsert = true;
    },
    failDelete: (value: boolean) => {
      failDelete = value;
    },
  };
}

test("cleanup precedes inserts, preserves existing values and keeps today's source rows", async () => {
  const f = fixture(
    [
      row("2026-04-16", "1", 99),
      row("2026-04-16", "2"),
      row("2026-04-17", "2"),
      row("2026-04-18", "2"),
    ],
    [row("2026-04-16", "1", 3)],
  );
  await f.run();
  assert.deepEqual(f.source(), [row("2026-04-18", "2")]);
  assert.equal(f.target().find((r) => r.aid === "1")?.coin, 3);
  assert.deepEqual(f.batches(), [
    ["2026-04-16/2", "2026-04-17/2", "2026-04-18/2"],
  ]);
  assert.equal(f.compressions(), 1);
});

test("cleanup succeeds before an insert failure without deleting missing records", async () => {
  const f = fixture(
    [row("2026-04-16", "1"), row("2026-04-17", "2")],
    [row("2026-04-16", "1")],
  );
  f.failInsert();
  await assert.rejects(f.run(), /insert failed/);
  assert.deepEqual(f.source(), [row("2026-04-17", "2")]);
  assert.deepEqual(f.target(), [row("2026-04-16", "1")]);
});

test("committed insert survives source delete failure and rerun cleans up without duplication", async () => {
  const f = fixture([row("2026-04-16", "2"), row("2026-04-17", "2")], []);
  f.failDelete(true);
  await assert.rejects(f.run(), /delete failed/);
  assert.equal(f.target().length, 2);
  assert.equal(f.source().length, 2);
  f.failDelete(false);
  await f.run();
  assert.equal(f.target().length, 2);
  assert.deepEqual(f.source(), []);
});

test("missing chunk is seeded once then the aid batch includes all dates", async () => {
  const f = fixture(
    [
      row("2026-04-16", "1"),
      row("2026-04-17", "1"),
      row("2026-04-17", "9007199254740993"),
    ],
    [],
    false,
  );
  await f.run();
  assert.deepEqual(f.source(), []);
  assert.equal(f.target().length, 3);
  assert.deepEqual(f.batches(), [
    ["2026-04-16/1"],
    ["2026-04-17/1"],
    ["2026-04-17/9007199254740993"],
  ]);
  assert.equal(f.compressions(), 0);
});

test("compression failure retains source after committed insert", async () => {
  const f = fixture([row("2026-04-16", "2")], []);
  f.failCompression();
  await assert.rejects(f.run(), /compression failed/);
  assert.deepEqual(f.target(), [row("2026-04-16", "2")]);
  assert.deepEqual(f.source(), [row("2026-04-16", "2")]);
});

test("same aid across chunks is inserted in separate chunk batches", async () => {
  const f = fixture(
    [row("2026-04-16", "2"), row("2026-04-17", "2")],
    [],
    true,
    true,
  );
  await f.run();
  assert.deepEqual(f.batches(), [["2026-04-16/2"], ["2026-04-17/2"]]);
  assert.equal(f.compressions(), 2);
  assert.deepEqual(f.source(), []);
});
