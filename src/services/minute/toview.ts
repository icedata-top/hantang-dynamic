import type { AccountContext } from "../../core/account";
import type { BiliToViewWebResponse } from "../../types/bilibili/toview";
import type { CompleteVideoMinuteTuple } from "../../types/models/minute";
import { sharedApiRateLimiter } from "../../utils/apiRateLimiter";
import { logger } from "../../utils/logger";
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

async function fetchToViewSamples(
  account: ToViewRequestAccount,
  sampledAt: Date,
): Promise<CompleteVideoMinuteTuple[] | null> {
  const release = await sharedApiRateLimiter.acquire();
  try {
    const response = await account.toViewClient.get("/web", {
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
    const isComplete =
      result.responseCode === 0 &&
      result.invalidItemCount === 0 &&
      response.data.data?.count === response.data.data?.list.length;
    if (!isComplete) {
      logger.warn("To View API response was incomplete or invalid");
      return null;
    }
    if (result.responseCode !== 0) {
      logger.warn("To View API returned a non-success response");
    }
    if (result.invalidItemCount > 0) {
      logger.warn(
        `To View API rejected ${result.invalidItemCount} invalid item(s)`,
      );
    }
    return result.samples;
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

  for (const account of selectedAccounts) {
    const accountSamples = await fetchToViewSamples(account, sampledAt);
    if (accountSamples === null) {
      const id = accountId(account);
      if (id !== null) failedAccountIds.push(id);
      continue;
    }
    for (const sample of accountSamples) {
      samples.push(sample);
    }
  }

  return { samples, failedAccountIds };
}
