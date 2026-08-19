import { loadAccounts } from "../core/account";
import { Database } from "../database";
import {
  runWatchLaterEmpiricalAddTest,
  selectWatchLaterEmpiricalAccount,
} from "../services/minute/watchLaterReconciliation";

async function main(): Promise<void> {
  const priorityArgument = process.argv
    .slice(2)
    .find((value) => value !== "--");
  const maxPriorityExclusive = Number(priorityArgument ?? 30);
  if (
    !Number.isInteger(maxPriorityExclusive) ||
    maxPriorityExclusive <= 1 ||
    maxPriorityExclusive > 721
  ) {
    throw new Error("Priority limit must be an integer from 2 through 721");
  }
  const account = selectWatchLaterEmpiricalAccount(loadAccounts());

  const database = Database.getInstance();
  await database.init();
  try {
    const result = await runWatchLaterEmpiricalAddTest(
      database,
      account,
      undefined,
      (text) => process.stdout.write(text),
      maxPriorityExclusive,
    );
    console.log(
      JSON.stringify({
        added: result.added,
        error: result.error,
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
