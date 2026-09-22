import type { Pool } from "pg";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

export interface PidV2Name {
  pidV2: number;
  name: string;
}

function validPidV2(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_POSTGRES_INTEGER
  );
}

/** Store the latest non-blank observed name for each valid PID V2 value. */
export async function upsertPidV2Names(
  pool: Pool,
  names: ReadonlyArray<PidV2Name>,
): Promise<number> {
  const namesByPidV2 = new Map<number, string>();
  for (const { pidV2, name } of names) {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (validPidV2(pidV2) && trimmedName.length > 0) {
      namesByPidV2.set(pidV2, trimmedName);
    }
  }
  const entries = [...namesByPidV2];
  if (entries.length === 0) return 0;

  const result = await pool.query(
    `INSERT INTO pid_v2_names (pid_v2, name)
     SELECT pid_v2, name
     FROM unnest($1::integer[], $2::text[]) AS incoming(pid_v2, name)
     ON CONFLICT (pid_v2) DO UPDATE SET name = EXCLUDED.name
     WHERE pid_v2_names.name IS DISTINCT FROM EXCLUDED.name`,
    [entries.map(([pidV2]) => pidV2), entries.map(([, name]) => name)],
  );
  return result.rowCount ?? 0;
}
