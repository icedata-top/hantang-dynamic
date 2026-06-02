export function calculateInitialDueTime(
  aid: bigint,
  priorityMinutes: number,
  now = new Date(),
): Date | null {
  if (priorityMinutes <= 0) return null;

  const periodMs = priorityMinutes * 60_000;
  const baseMs = Math.floor(now.getTime() / periodMs) * periodMs;
  const offsetMinutes = Number(aid % BigInt(priorityMinutes));
  let dueMs = baseMs + offsetMinutes * 60_000;

  if (dueMs < now.getTime()) {
    dueMs += periodMs;
  }

  return new Date(dueMs);
}
