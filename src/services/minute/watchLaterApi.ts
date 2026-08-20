import type { CookieJar } from "tough-cookie";
import { config } from "../../config";
import type { WatchLaterAction } from "../../database/watchLater";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import type { ToViewAccountIdentity, ToViewClient } from "./toview";
import { validateToViewResponse } from "./toviewContract";

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
  completedAt: Date;
}

export type WatchLaterMutationPrePostAbortReason =
  | "stopped"
  | "lease_lost"
  | "attempt_unavailable";

export class WatchLaterMutationPrePostAbortError extends Error {
  constructor(readonly reason: WatchLaterMutationPrePostAbortReason) {
    super(`Watch-later mutation aborted before POST: ${reason}`);
    this.name = "WatchLaterMutationPrePostAbortError";
  }
}

export interface WatchLaterMutationOptions {
  beforePost?(): Promise<WatchLaterMutationPrePostAbortReason | undefined>;
}

async function csrfToken(account: WatchLaterAccountContext): Promise<string> {
  if (config.bilibili.csrfToken) return config.bilibili.csrfToken;
  if (!account.cookieJar) {
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
  const release = await sharedApiRateLimiter.acquire();
  try {
    const response = await client.get("/web", {
      params: {
        pn: 1,
        ps: 3000,
        viewed: 0,
        key: "",
        asc: false,
        need_split: true,
      },
    });
    const validated = validateToViewResponse(response.data, now);
    const listed =
      response.data.code === 0 ? response.data.data?.list.length : undefined;
    const expected =
      response.data.code === 0 ? response.data.data?.count : undefined;
    if (
      validated.responseCode !== 0 ||
      validated.invalidItemCount !== 0 ||
      expected === undefined ||
      listed === undefined ||
      expected !== listed
    ) {
      return null;
    }
    return {
      aids: new Set(validated.samples.map((sample) => sample.aid.toString())),
      completedAt: now,
    };
  } catch {
    return null;
  } finally {
    release();
  }
}

export async function mutateWatchLater(
  account: WatchLaterAccountContext,
  aid: bigint,
  action: WatchLaterAction,
  options: WatchLaterMutationOptions = {},
): Promise<number> {
  // Prepare all request data before the final cancellation/lease fence.
  const body = new URLSearchParams({
    aid: aid.toString(),
    csrf: await csrfToken(account),
  });
  const release = await sharedApiRateLimiter.acquire();
  try {
    let abortReason: WatchLaterMutationPrePostAbortReason | undefined;
    try {
      abortReason = await options.beforePost?.();
    } catch {
      abortReason = "lease_lost";
    }
    if (abortReason) {
      throw new WatchLaterMutationPrePostAbortError(abortReason);
    }
    const response = await account.toViewClient.post(
      action === "add" ? "/add" : "/del",
      body,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        noRetry: true,
        rawApiErrors: true,
      },
    );
    return response.data.code;
  } finally {
    release();
  }
}
