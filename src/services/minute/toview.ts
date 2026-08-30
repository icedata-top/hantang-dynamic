import type { AccountContext } from "../../core/account";
import type { BiliToViewWebResponse } from "../../types/bilibili/toview";
import type { CompleteVideoMinuteTuple } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
import type { ToViewValidationResult } from "./toviewContract";
import { validateToViewResponse } from "./toviewContract";

export interface WatchLaterToViewAccount {
  accountId: bigint;
}

export const MINUTE_REQUEST_TIMEOUT_MS = 120_000;

export interface ToViewAccountIdentity {
  uid: string;
}

export interface ToViewClient {
  get(
    url: string,
    config: {
      noRetry: true;
      rawApiErrors: true;
      timeout: number;
      params: {
        pn: number;
        ps: number;
        viewed: number;
        key: string;
        asc: boolean;
        need_split: boolean;
      };
    },
  ): Promise<{ data: BiliToViewWebResponse }>;
}

export interface ToViewRequestAccount extends ToViewAccountIdentity {
  toViewClient: ToViewClient;
}

export interface ToViewSamplesResult {
  failedAccountIds: bigint[];
  samplesByAccountId: ReadonlyMap<bigint, CompleteVideoMinuteTuple[]>;
}

export class ToViewRateLimitError extends Error {
  constructor() {
    super("To View request rate limited");
    this.name = "ToViewRateLimitError";
  }
}

export type ToViewAccount = AccountContext;

function accountId(account: ToViewAccountIdentity): bigint | null {
  if (!/^\d+$/.test(account.uid)) return null;
  try {
    return BigInt(account.uid);
  } catch {
    return null;
  }
}

export function selectWatchLaterToViewAccounts<T extends ToViewAccountIdentity>(
  accounts: T[],
  selectedWatchLaterAccounts: WatchLaterToViewAccount[],
): T[] {
  const accountsById = new Map<bigint, T>();
  for (const account of accounts) {
    const id = accountId(account);
    if (id !== null) accountsById.set(id, account);
  }

  const selectedIds = new Set<bigint>();
  return selectedWatchLaterAccounts.flatMap((watchLaterAccount) => {
    if (selectedIds.has(watchLaterAccount.accountId)) return [];
    selectedIds.add(watchLaterAccount.accountId);
    const account = accountsById.get(watchLaterAccount.accountId);
    return account ? [account] : [];
  });
}

export async function fetchCompleteToViewSnapshot(
  client: ToViewClient,
  sampledAt: Date,
): Promise<ToViewValidationResult | null> {
  const release = await sharedApiRateLimiter.acquire();
  try {
    const response = await client.get("/web", {
      noRetry: true,
      rawApiErrors: true,
      timeout: MINUTE_REQUEST_TIMEOUT_MS,
      params: {
        pn: 1,
        ps: 3000,
        viewed: 0,
        key: "",
        asc: false,
        need_split: true,
      },
    });
    if (response.data.code === -702) throw new ToViewRateLimitError();
    const result = validateToViewResponse(response.data, sampledAt);
    if (!result.complete) {
      logger.warn("To View API response was incomplete or invalid");
      return null;
    }
    return result;
  } catch (error) {
    if (
      error instanceof ToViewRateLimitError ||
      (error !== null &&
        typeof error === "object" &&
        "status" in error &&
        "code" in error &&
        error.status === 200 &&
        error.code === -702)
    ) {
      throw new ToViewRateLimitError();
    }
    logger.warn("To View API request failed");
    logger.debug(error);
    return null;
  } finally {
    release();
  }
}

export async function sampleWatchLaterToViewAccountsWithStatus(
  accounts: ToViewRequestAccount[],
  selectedWatchLaterAccounts: WatchLaterToViewAccount[],
  sampledAt: Date,
  onRateLimitedAccount?: (accountId: bigint) => void,
): Promise<ToViewSamplesResult> {
  const selectedAccounts = selectWatchLaterToViewAccounts(
    accounts,
    selectedWatchLaterAccounts,
  );
  const failedAccountIds: bigint[] = [];
  const samplesByAccountId = new Map<bigint, CompleteVideoMinuteTuple[]>();

  for (const account of selectedAccounts) {
    let snapshot: ToViewValidationResult | null = null;
    try {
      snapshot = await fetchCompleteToViewSnapshot(
        account.toViewClient,
        sampledAt,
      );
    } catch (error) {
      if (!(error instanceof ToViewRateLimitError)) throw error;
      const id = accountId(account);
      if (id !== null) onRateLimitedAccount?.(id);
    }
    if (snapshot === null) {
      const id = accountId(account);
      if (id !== null) failedAccountIds.push(id);
      continue;
    }
    const id = accountId(account);
    if (id !== null) samplesByAccountId.set(id, snapshot.samples);
  }

  return { failedAccountIds, samplesByAccountId };
}
