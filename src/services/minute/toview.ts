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

export interface ToViewAccountIdentity {
  uid: string;
}

export interface ToViewClient {
  get(
    url: string,
    config: {
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
  samples: CompleteVideoMinuteTuple[];
  failedAccountIds: bigint[];
  samplesByAccountId: ReadonlyMap<bigint, CompleteVideoMinuteTuple[]>;
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
      params: {
        pn: 1,
        ps: 3000,
        viewed: 0,
        key: "",
        asc: false,
        need_split: true,
      },
    });
    const result = validateToViewResponse(response.data, sampledAt);
    if (!result.complete) {
      logger.warn("To View API response was incomplete or invalid");
      return null;
    }
    return result;
  } catch (error) {
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
): Promise<ToViewSamplesResult> {
  const selectedAccounts = selectWatchLaterToViewAccounts(
    accounts,
    selectedWatchLaterAccounts,
  );
  const samples: CompleteVideoMinuteTuple[] = [];
  const failedAccountIds: bigint[] = [];
  const samplesByAccountId = new Map<bigint, CompleteVideoMinuteTuple[]>();

  for (const account of selectedAccounts) {
    const snapshot = await fetchCompleteToViewSnapshot(
      account.toViewClient,
      sampledAt,
    );
    if (snapshot === null) {
      const id = accountId(account);
      if (id !== null) failedAccountIds.push(id);
      continue;
    }
    const id = accountId(account);
    if (id !== null) samplesByAccountId.set(id, snapshot.samples);
    for (const sample of snapshot.samples) {
      samples.push(sample);
    }
  }

  return { samples, failedAccountIds, samplesByAccountId };
}
