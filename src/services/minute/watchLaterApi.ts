import type { CookieJar } from "tough-cookie";
import { isAccountAuthError } from "../../api/client";
import { config } from "../../config";
import type { WatchLaterAction } from "../../database/watchLater";
import { watchLaterMutationsTotal } from "../../metrics/registry";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
import {
  fetchCompleteToViewSnapshot,
  type ToViewAccountIdentity,
  type ToViewClient,
} from "./toview";

interface WatchLaterResponse {
  code: number;
}

interface WatchLaterMutationRequestConfig {
  headers: { "Content-Type": string };
  noRetry: true;
  rawApiErrors: true;
}

export interface WatchLaterMutationClient extends ToViewClient {
  post(
    url: string,
    data: URLSearchParams,
    config: WatchLaterMutationRequestConfig,
  ): Promise<{ data: WatchLaterResponse }>;
}

export interface WatchLaterAccountContext extends ToViewAccountIdentity {
  cookieJar: CookieJar | null;
  toViewClient: WatchLaterMutationClient;
  enableWatchLater?: boolean;
}

export interface WatchLaterSnapshot {
  aids: Set<string>;
  pidV2Metadata: Array<{ aid: bigint; pidV2: number }>;
}

const WATCH_LATER_MEMBERSHIP_CAPACITY = 1_000;

export type WatchLaterMutationPrePostAbortReason = "deadline" | "stopped";

export class WatchLaterMutationPrePostAbortError extends Error {
  constructor(readonly reason: WatchLaterMutationPrePostAbortReason) {
    super(`Watch-later mutation aborted before POST: ${reason}`);
    this.name = "WatchLaterMutationPrePostAbortError";
  }
}

export interface WatchLaterMutationOptions {
  beforePost?(): Promise<WatchLaterMutationPrePostAbortReason | undefined>;
}

function recordMutationResult(action: WatchLaterAction, code: number): void {
  watchLaterMutationsTotal.inc({
    action,
    outcome:
      code === 0 ? "succeeded" : code === 90001 ? "capacity_blocked" : "failed",
  });
}

function rawApiErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

async function csrfToken(account: WatchLaterAccountContext): Promise<string> {
  if (!account.cookieJar) {
    if (config.bilibili.csrfToken) return config.bilibili.csrfToken;
    throw new Error("Watch-later mutation requires an authenticated account");
  }
  const cookies = await account.cookieJar.getCookies(
    "https://www.bilibili.com/",
  );
  const token = cookies.find((cookie) => cookie.key === "bili_jct")?.value;
  if (!token) throw new Error("Watch-later account is missing bili_jct");
  return token;
}

export async function fetchWatchLaterSnapshot(
  client: ToViewClient,
  now = new Date(),
): Promise<WatchLaterSnapshot | null> {
  const snapshot = await fetchCompleteToViewSnapshot(client, now);
  if (!snapshot || snapshot.samples.length > WATCH_LATER_MEMBERSHIP_CAPACITY) {
    return null;
  }
  if (snapshot.invalidPidV2Count > 0) {
    logger.warn(
      `Watch Later snapshot ignored pid_v2 metadata for ${snapshot.invalidPidV2Count} item(s)`,
    );
  }
  return {
    aids: new Set(snapshot.samples.map((sample) => sample.aid.toString())),
    pidV2Metadata: snapshot.pidV2Metadata,
  };
}

export async function mutateWatchLater(
  account: WatchLaterAccountContext,
  aid: bigint,
  action: WatchLaterAction,
  options: WatchLaterMutationOptions = {},
): Promise<number> {
  // Prepare all request data before the final cancellation fence.
  const body = new URLSearchParams({
    aid: aid.toString(),
    csrf: await csrfToken(account),
  });
  const release = await sharedApiRateLimiter.acquire();
  try {
    const abortReason = await options.beforePost?.();
    if (abortReason) {
      throw new WatchLaterMutationPrePostAbortError(abortReason);
    }
    try {
      const response = await account.toViewClient.post(
        action === "add" ? "/add" : "/del",
        body,
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          noRetry: true,
          rawApiErrors: true,
        },
      );
      recordMutationResult(action, response.data.code);
      return response.data.code;
    } catch (error) {
      if (isAccountAuthError(error)) {
        watchLaterMutationsTotal.inc({ action, outcome: "failed" });
        throw error;
      }
      const code = rawApiErrorCode(error);
      if (code !== undefined) {
        recordMutationResult(action, code);
        return code;
      }
      watchLaterMutationsTotal.inc({ action, outcome: "ambiguous" });
      throw error;
    }
  } finally {
    release();
  }
}
