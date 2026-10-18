import { sleep } from "./datetime";
import { logger } from "./logger";

const TRANSIENT_CODE =
  /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|08\d{3}|40001|40P01|53300|53400|57P0[1-3])$/;
const TRANSIENT_MESSAGE =
  /timeout exceeded when trying to connect|connection (?:terminated|lost|closed|reset)|server closed the connection|socket hang up|network error|too many clients|database system is (?:starting up|shutting down)|terminating connection due to administrator command/i;

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    cause?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof candidate.code === "string" && TRANSIENT_CODE.test(candidate.code))
    return true;
  if (
    typeof candidate.message === "string" &&
    TRANSIENT_MESSAGE.test(candidate.message)
  )
    return true;
  return candidate.cause !== undefined && isTransientError(candidate.cause);
}

/**
 * Retry an operation only when it fails with a transient connection error.
 *
 * `maxAttempts` counts total attempts, including the first one, unlike
 * `retryDelay` where the count is retries after the initial call.
 */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  delayMs: number,
  label: string,
): Promise<T> {
  const limit = Math.max(1, maxAttempts);
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= limit || !isTransientError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `${label} failed transiently (attempt ${attempt}/${limit}), retrying in ${delayMs}ms: ${message}`,
      );
      await sleep(delayMs);
    }
  }
}
