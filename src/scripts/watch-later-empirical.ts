import { loadAccounts } from "../core/account";
import { Database } from "../database";
import {
  runWatchLaterEmpiricalAddTest,
  selectWatchLaterEmpiricalAccount,
} from "../services/minute/watchLaterReconciliation";

async function main(): Promise<void> {
  const account = selectWatchLaterEmpiricalAccount(loadAccounts());

  const database = Database.getInstance();
  await database.init();
  try {
    const result = await runWatchLaterEmpiricalAddTest(
      database,
      account,
      undefined,
      (text) => process.stdout.write(text),
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
