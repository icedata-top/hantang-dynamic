import { config } from "../config";
import { loadAccounts } from "../core/account";
import { Database } from "../database";
import type { WatchLaterAccountContext } from "../services/minute/watchLaterApi";
import { runWatchLaterEmpiricalAddTest } from "../services/minute/watchLaterReconciliation";

async function main(): Promise<void> {
  const testAccountId = config.bilibili.watchLaterTestAccountId;
  if (!testAccountId) {
    throw new Error("bilibili.watch_later_test_account_id must be configured");
  }
  const account = loadAccounts().find(
    (candidate) => candidate.uid === testAccountId,
  );
  if (!account) {
    throw new Error("Configured watch-later test account was not loaded");
  }

  const database = Database.getInstance();
  await database.init();
  try {
    const result = await runWatchLaterEmpiricalAddTest(
      database,
      account as WatchLaterAccountContext,
    );
    console.log(
      JSON.stringify({
        added: result.added,
        postCount: result.postCount,
        preCount: result.preCount,
        reason: result.reason,
        selected: result.selected,
      }),
    );
  } finally {
    await database.close();
  }
}

void main();
