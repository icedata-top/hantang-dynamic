import assert from "node:assert/strict";
import test, { mock } from "node:test";
import mysql from "mysql2/promise";
import type { PoolClient } from "pg";
import { backfillVideoDaily } from "./manualVideoDaily";

type Row = { record_date: string; aid: string; coin: number };
const row = (record_date: string, aid: string, coin = 1): Row => ({
  record_date,
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
  source: Row[],
  target: Row[],
  {
    missingChunk = false,
    split = false,
    failInsert = 0,
    failCompression = false,
    failDelete = false,
    keepSource = false,
    omitInsertedRow = false,
    size = 1,
    startDate = "2026-04-16",
    endDate = "2026-04-18",
    today = "2026-04-18",
  } = {},
) {
  let sourceRows = [...source],
    targetRows = [...target];
  let snapshot: Row[] | undefined;
  let cursor: string[] | undefined;
  let exists = !missingChunk,
    inserts = 0,
    compressions = 0;
  const deleted: string[] = [],
    windows: string[][] = [];
  let sourceAtFirstInsert: Row[] | undefined;
  const pg = {
    async query(sql: string, args: string[] = []) {
      if (sql.includes("FROM pg_catalog.pg_foreign_table"))
        return {
          rows: [
            {
              local_schema: "hantang_dynamic",
              local_table: "mysql_video_daily",
              fdw: "mysql_fdw",
              server_options: ["host=127.0.0.1"],
              table_options: ["dbname=hantang", "table_name=video_daily"],
              mapping_id: 1,
              mapping_options: ["username=fake"],
            },
          ],
        };
      if (sql.includes("FROM timescaledb_information.chunks")) {
        if (!exists) return { rows: [] };
        if (sql.includes("AS start,"))
          return {
            rows: split
              ? [
                  { start: "2026-04-16", finish: "2026-04-16" },
                  { start: "2026-04-17", finish: "2026-04-18" },
                ]
              : [{ start: startDate, finish: endDate }],
          };
        return {
          rows: [
            {
              name: "chunk",
              is_compressed: !missingChunk,
              finish:
                split && args[1] === "2026-04-16" ? "2026-04-16" : "2026-04-30",
            },
          ],
        };
      }
      if (sql.startsWith("DECLARE manual_daily_aids")) {
        assert.equal(
          cursor,
          undefined,
          "previous window cursor must be closed",
        );
        assert.equal(
          snapshot,
          undefined,
          "held cursor is prepared in autocommit",
        );
        windows.push(args.slice(0, 2));
        cursor = [
          ...new Set(
            sourceRows
              .filter(
                (r) =>
                  r.record_date >= args[0] &&
                  r.record_date <= args[1] &&
                  BigInt(r.aid) > BigInt(args[2]),
              )
              .sort(compare)
              .map((r) => r.aid),
          ),
        ];
        return { rows: [] };
      }
      if (sql.startsWith("FETCH FORWARD")) {
        assert.ok(cursor, "held cursor survives batch commits");
        const count = Number(sql.split(" ")[2]);
        return { rows: cursor.splice(0, count).map((aid) => ({ aid })) };
      }
      if (sql === "CLOSE manual_daily_aids") {
        assert.ok(cursor);
        cursor = undefined;
      }
      const sourceBatch = () => {
        const [, , after, last, ...dates] = args;
        return sourceRows.filter(
          (r) =>
            dates.includes(r.record_date) &&
            BigInt(r.aid) > BigInt(after) &&
            BigInt(r.aid) <= BigInt(last),
        );
      };
      if (sql.startsWith("SELECT b.record_date")) {
        const batch = sourceBatch();
        const dates = [...new Set(batch.map((r) => r.record_date))];
        return {
          rows: dates.map((date) => ({
            date,
            complete: batch
              .filter((r) => r.record_date === date)
              .every((r) => targetRows.some((t) => key(t) === key(r))),
          })),
        };
      }
      if (sql.startsWith("SELECT record_date::text,aid::text"))
        return {
          rows: sourceRows
            .filter((r) => r.record_date >= args[0] && r.record_date <= args[1])
            .sort(
              (a, b) =>
                a.record_date.localeCompare(b.record_date) || compare(a, b),
            )
            .slice(0, 1),
        };
      if (sql === "BEGIN") snapshot = [...targetRows];
      if (sql === "ROLLBACK") {
        targetRows = snapshot ?? targetRows;
        snapshot = undefined;
      }
      if (sql === "COMMIT") snapshot = undefined;
      if (sql.startsWith('INSERT INTO "hantang_dynamic".video_daily')) {
        sourceAtFirstInsert ??= [...sourceRows];
        if (++inserts === failInsert) throw new Error("insert failed");
        const candidates = sql.includes("FROM (SELECT")
          ? sourceBatch()
          : [row(args[0], args[1], Number(args[2]))];
        const missing = candidates.filter(
          (r) => !targetRows.some((t) => key(t) === key(r)),
        );
        if (!omitInsertedRow) targetRows.push(...missing);
        exists = true;
        return { rows: [], rowCount: missing.length };
      }
      if (sql.startsWith("SELECT pg_advisory_unlock"))
        assert.equal(
          cursor,
          undefined,
          "release held cursor on success and failure",
        );
      if (sql.startsWith("CALL convert_to_columnstore")) {
        if (failCompression) throw new Error("compression failed");
        compressions++;
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const deletes: string[][] = [];
  let closed = 0;
  const connection = {
    async execute(sql: string, args: string[]) {
      if (sql.startsWith("SET SESSION")) return [{ affectedRows: 0 }];
      assert.match(
        sql,
        /^DELETE FROM `hantang`\.`video_daily` WHERE record_date IN \(\?(?:,\?)*\) AND record_date < \?$/,
      );
      const dates = args.slice(0, -1);
      assert.ok(dates.every((date) => date < args[args.length - 1]));
      assert.ok(
        sourceRows
          .filter((r) => dates.includes(r.record_date))
          .every((r) => targetRows.some((t) => key(t) === key(r))),
        "whole dates must exist in committed PG before deletion",
      );
      assert.equal(snapshot, undefined);
      assert.equal(
        cursor,
        undefined,
        "close the source cursor before deleting",
      );
      deletes.push(dates);
      if (failDelete) throw new Error("delete failed");
      const before = sourceRows.length;
      sourceRows = sourceRows.filter((r) => !dates.includes(r.record_date));
      deleted.push(...dates);
      return [{ affectedRows: before - sourceRows.length }];
    },
    async commit() {},
    async end() {
      closed++;
    },
  };
  const progress: string[] = [];
  return {
    progress,
    run: async () => {
      const connect = mock.method(
        mysql,
        "createConnection",
        async () => connection,
      );
      try {
        await backfillVideoDaily(pg, {
          startDate,
          endDate,
          schema: "hantang_dynamic",
          today,
          size,
          keepSource,
          onProgress: (message) => progress.push(message),
        });
      } finally {
        connect.mock.restore();
      }
    },
    deletes: () => deletes,
    closed: () => closed,
    source: () => sourceRows,
    target: () => targetRows,
    deleted: () => deleted,
    firstInsertSource: () => sourceAtFirstInsert,
    windows: () => windows,
    compressions: () => compressions,
    allowDelete: () => {
      failDelete = false;
    },
  };
}

test("complete dates are cleaned first, partial dates wait for all aids, existing values and today are preserved", async () => {
  const f = fixture(
    [
      row("2026-04-16", "1"),
      row("2026-04-17", "1", 99),
      row("2026-04-17", "2"),
      row("2026-04-18", "2"),
    ],
    [row("2026-04-16", "1"), row("2026-04-17", "1", 3)],
  );
  await f.run();
  assert.deepEqual(f.firstInsertSource(), [
    row("2026-04-17", "1", 99),
    row("2026-04-17", "2"),
    row("2026-04-18", "2"),
  ]);
  assert.deepEqual(f.deleted(), ["2026-04-16", "2026-04-17"]);
  assert.deepEqual(f.source(), [row("2026-04-18", "2")]);
  assert.equal(
    f.target().find((r) => r.record_date === "2026-04-17" && r.aid === "1")
      ?.coin,
    3,
  );
});

test("failure after one committed aid retains the entire incomplete date", async () => {
  const f = fixture([row("2026-04-16", "1"), row("2026-04-16", "2")], [], {
    failInsert: 2,
  });
  await assert.rejects(f.run(), /insert failed/);
  assert.deepEqual(f.target(), [row("2026-04-16", "1")]);
  assert.equal(f.source().length, 2);
  assert.deepEqual(f.deleted(), []);
  await f.run();
  assert.equal(f.target().length, 2);
  assert.deepEqual(f.source(), []);
});

test("source delete failure can be retried without duplicate inserts", async () => {
  const f = fixture([row("2026-04-16", "2"), row("2026-04-17", "2")], [], {
    failDelete: true,
  });
  await assert.rejects(f.run(), /delete failed/);
  assert.equal(f.target().length, 2);
  assert.equal(f.source().length, 2);
  assert.equal(f.closed(), 1);
  f.allowDelete();
  await f.run();
  assert.equal(f.target().length, 2);
  assert.deepEqual(f.source(), []);
});

test("missing target chunk is seeded and large aid values span dates without source loss", async () => {
  const f = fixture(
    [
      row("2026-04-16", "9007199254740993"),
      row("2026-04-17", "9007199254740993"),
    ],
    [],
    { missingChunk: true },
  );
  await f.run();
  assert.equal(f.target().length, 2);
  assert.deepEqual(f.source(), []);
  assert.equal(f.compressions(), 0);
});

test("compression failure retains the whole date after committed insert", async () => {
  const f = fixture([row("2026-04-16", "2")], [], { failCompression: true });
  await assert.rejects(f.run(), /compression failed/);
  assert.deepEqual(f.target(), [row("2026-04-16", "2")]);
  assert.equal(f.source().length, 1);
});

test("every chunk is cleaned before inserts and both passes preserve chunk locality", async () => {
  const f = fixture(
    [row("2026-04-16", "1"), row("2026-04-17", "1"), row("2026-04-18", "2")],
    [row("2026-04-16", "1"), row("2026-04-17", "1")],
    { split: true },
  );
  await f.run();
  assert.deepEqual(f.firstInsertSource(), [row("2026-04-18", "2")]);
  assert.ok(
    f
      .windows()
      .every(
        ([from, through]) =>
          (from === "2026-04-16" && through === "2026-04-16") ||
          (from >= "2026-04-17" && through === "2026-04-18"),
      ),
  );
  assert.deepEqual(f.deleted(), ["2026-04-16", "2026-04-17"]);
});

test("an aid batch spanning more than 1000 source rows preserves coverage across dates and batches", async () => {
  const source = Array.from({ length: 1200 }, (_, i) =>
    row(
      i % 2 ? "2026-04-16" : "2026-04-17",
      String(9007199254740993n + BigInt(i)),
    ),
  );
  source.push(row("2026-04-18", source[0].aid));
  const f = fixture(source, [source[0]], { size: 1100 });
  await f.run();
  assert.equal(f.target().length, source.length);
  assert.deepEqual(new Set(f.target().map(key)), new Set(source.map(key)));
  assert.deepEqual(new Set(f.deleted()), new Set(["2026-04-16", "2026-04-17"]));
  assert.deepEqual(f.source(), [source[source.length - 1]]);
});

test("worker rejects unsafe fetch sizes before opening a source cursor", async () => {
  for (const size of [
    0,
    -1,
    1.5,
    Infinity,
    2147483648,
    "1; SELECT 1" as unknown as number,
  ]) {
    await assert.rejects(
      fixture([], [], { size }).run(),
      /positive PostgreSQL integer/,
    );
  }
});

test("one native delete per window includes noncontiguous complete dates without deleting an incomplete gap", async () => {
  const f = fixture(
    [
      row("2026-04-15", "1"),
      row("2026-04-16", "1"),
      row("2026-04-17", "1"),
      row("2026-04-18", "1"),
    ],
    [row("2026-04-15", "1"), row("2026-04-17", "1"), row("2026-04-18", "1")],
    { startDate: "2026-04-15", failInsert: 1 },
  );
  await assert.rejects(f.run(), /insert failed/);
  assert.deepEqual(f.deletes(), [["2026-04-15", "2026-04-17"]]);
  assert.deepEqual(f.source(), [
    row("2026-04-16", "1"),
    row("2026-04-18", "1"),
  ]);
  assert.equal(f.closed(), 1);
});

test("keep-source copies missing keys across dates and today while retaining source and existing PG values", async () => {
  const source = [
    row("2026-04-16", "1"),
    row("2026-04-17", "1", 99),
    row("2026-04-17", "2"),
    row("2026-04-18", "2"),
  ];
  const f = fixture(
    source,
    [row("2026-04-16", "1"), row("2026-04-17", "1", 3)],
    {
      keepSource: true,
    },
  );
  await f.run();
  assert.deepEqual(f.source(), source);
  assert.deepEqual(f.target(), [
    row("2026-04-16", "1"),
    row("2026-04-17", "1", 3),
    row("2026-04-17", "2"),
    row("2026-04-18", "2"),
  ]);
  assert.match(
    f.progress[f.progress.length - 1] ?? "",
    /copy completed.*source retained/,
  );
});

test("keep-source reports incomplete postcommit key coverage", async () => {
  const source = [row("2026-04-16", "1")];
  const f = fixture(source, [], { keepSource: true, omitInsertedRow: true });
  await assert.rejects(
    f.run(),
    /incomplete target coverage for dates 2026-04-16; source retained/,
  );
  assert.deepEqual(f.source(), source);
});
