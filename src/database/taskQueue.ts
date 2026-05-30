import type { Pool } from "pg";
import type { VideoCollectionTask } from "../types/models/minute.js";

function mapTask(row: Record<string, unknown>): VideoCollectionTask {
  return {
    id: BigInt(row.id as string | number),
    aid: BigInt(row.aid as string | number),
    taskType: row.task_type as VideoCollectionTask["taskType"],
    dedupeKey: row.dedupe_key as string,
    dueAt: row.due_at as Date,
    lockedUntil: (row.locked_until as Date | null) ?? null,
    attemptCount: Number(row.attempt_count),
    gateValue:
      row.gate_value === null || row.gate_value === undefined
        ? null
        : BigInt(row.gate_value as string | number),
    gateReason: (row.gate_reason as string | null) ?? null,
  };
}

export async function enqueueVideoCollectionTasks(
  pool: Pool,
  now = new Date(),
  maxAttempts = 5,
): Promise<number> {
  const result = await pool.query(
    "SELECT fn_enqueue_video_collection_tasks($1, $2) AS count",
    [now, maxAttempts],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function enqueueVideoCollectionGateTasks(
  pool: Pool,
  now = new Date(),
  options?: {
    gateLeadTimeMinutes?: number;
    gateMinLeadRatio?: number;
    gateMaxLeadViews?: number;
    maxAttempts?: number;
  },
): Promise<number> {
  const result = await pool.query(
    `
    SELECT fn_enqueue_video_collection_gate_tasks(
      $1,
      make_interval(mins => $2::int),
      $3,
      $4,
      $5
    ) AS count
  `,
    [
      now,
      options?.gateLeadTimeMinutes ?? 30,
      options?.gateMinLeadRatio ?? 0.1,
      options?.gateMaxLeadViews ?? 500,
      options?.maxAttempts ?? 5,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function claimVideoCollectionTasks(
  pool: Pool,
  limit = 50,
  lockDurationSeconds = 30,
  now = new Date(),
): Promise<VideoCollectionTask[]> {
  const result = await pool.query(
    `
    SELECT *
    FROM fn_claim_video_collection_tasks(
      $1,
      $2,
      make_interval(secs => $3::int)
    )
  `,
    [now, limit, lockDurationSeconds],
  );
  return result.rows.map(mapTask);
}

export async function ackVideoCollectionTasks(
  pool: Pool,
  taskIds: bigint[],
  now = new Date(),
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await pool.query(
    "SELECT fn_ack_video_collection_tasks($1::bigint[], $2) AS count",
    [taskIds.map((id) => id.toString()), now],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function failVideoCollectionTasks(
  pool: Pool,
  taskIds: bigint[],
  now = new Date(),
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await pool.query(
    "SELECT fn_fail_video_collection_tasks($1::bigint[], $2) AS count",
    [taskIds.map((id) => id.toString()), now],
  );
  return Number(result.rows[0]?.count ?? 0);
}
