import type { Pool } from "pg";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

export interface PidV2Name {
  pidV2: number;
  name: string;
}

interface PidV2NameCache {
  names?: Map<number, string>;
  loading?: Promise<void>;
  pending: Promise<void>;
}

const caches = new WeakMap<Pool, PidV2NameCache>();

function validPidV2(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_POSTGRES_INTEGER
  );
}

function getCache(pool: Pool): PidV2NameCache {
  let cache = caches.get(pool);
  if (!cache) {
    cache = { pending: Promise.resolve() };
    caches.set(pool, cache);
  }
  return cache;
}

async function loadNames(pool: Pool, cache: PidV2NameCache): Promise<void> {
  if (cache.names) return;

  if (!cache.loading) {
    cache.loading = pool
      .query<{ pid_v2: number; name: string }>(
        "SELECT pid_v2, name FROM pid_v2_names",
      )
      .then((result) => {
        cache.names = new Map(
          result.rows.map(({ pid_v2: pidV2, name }) => [pidV2, name]),
        );
      })
      .finally(() => {
        cache.loading = undefined;
      });
  }

  await cache.loading;
}

function enqueue<T>(
  cache: PidV2NameCache,
  operation: () => Promise<T>,
): Promise<T> {
  const result = cache.pending.then(operation, operation);
  cache.pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

  const cache = getCache(pool);
  return enqueue(cache, async () => {
    await loadNames(pool, cache);

    const changedEntries = entries.filter(
      ([pidV2, name]) => cache.names?.get(pidV2) !== name,
    );
    if (changedEntries.length === 0) return 0;

    const result = await pool.query(
      `INSERT INTO pid_v2_names (pid_v2, name)
       SELECT pid_v2, name
       FROM unnest($1::integer[], $2::text[]) AS incoming(pid_v2, name)
       ON CONFLICT (pid_v2) DO UPDATE SET name = EXCLUDED.name
       WHERE pid_v2_names.name IS DISTINCT FROM EXCLUDED.name`,
      [
        changedEntries.map(([pidV2]) => pidV2),
        changedEntries.map(([, name]) => name),
      ],
    );
    for (const [pidV2, name] of changedEntries) {
      cache.names?.set(pidV2, name);
    }
    return result.rowCount ?? 0;
  });
}
