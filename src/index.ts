import { config } from "./config";
import { loadAccounts } from "./core/account";
import { Database } from "./database";
import { MinuteHandler } from "./services/minute/minuteHandler";
import { DynamicTracker } from "./services/tracker";
import { logger } from "./utils/logger";

async function runTracker() {
  logger.info("Starting Bilibili Video Tracker");
  logger.debug("Configuration:", config);

  // Initialize Database
  await Database.getInstance().init();

  // Load all configured accounts (one per cookie file, or one legacy sessdata account)
  const accounts = loadAccounts();
  logger.info(
    `Loaded ${accounts.length} account(s): ${accounts.map((a) => a.uid).join(", ")}`,
  );

  const trackers = accounts.map((account) => new DynamicTracker(account));
  const minuteHandler = config.minute.enabled ? new MinuteHandler() : null;
  minuteHandler?.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Stopping Tracker...");
    for (const tracker of trackers) {
      tracker.stop();
    }
    minuteHandler?.stop();
    try {
      await Database.getInstance().close();
      logger.info("Database connection closed");
    } catch (error) {
      logger.error("Error closing database connection:", error);
    }
    logger.info("Tracker stopped");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run all account trackers in parallel (each runs its own infinite loop)
  await Promise.all(trackers.map((t) => t.start()));
}

async function main() {
  const args = process.argv.slice(2);

  // Check for tool mode
  if (args.includes("--repair")) {
    const repairIndex = args.indexOf("--repair");
    const filterCandidate = args[repairIndex + 1];
    const filter =
      filterCandidate && !filterCandidate.startsWith("--")
        ? filterCandidate
        : undefined;
    const fixAids = args.includes("--fix-aids");
    const { runRepairVideos } = await import("./scripts/repair-videos");
    await runRepairVideos(filter, { fixAids });
    return;
  }

  if (args.includes("--relation")) {
    const { runManageRelations } = await import("./scripts/manage-relations");
    await runManageRelations();
    return;
  }

  if (args.includes("--import")) {
    const { runImportCsv } = await import("./scripts/import-csv");
    await runImportCsv();
    return;
  }

  // Default: run tracker
  await runTracker();
}

main().catch(async (error) => {
  const message = `Fatal Error: ${error}\n${
    error instanceof Error ? error.stack : ""
  }`;
  logger.error(message);

  try {
    // Only import notify when needed to avoid circular dependency issues at startup if any
    const { notifyWarning } = await import("./utils/notifier/notifier");
    await notifyWarning(message);
  } catch (notifyError) {
    logger.error("Failed to send notification for fatal error:", notifyError);
  }

  process.exit(1);
});
