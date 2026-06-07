import { config } from "./config";
import { loadAccounts } from "./core/account";
import { Database } from "./database";
import { initializeBuildInfo } from "./metrics/registry";
import { startMetricsServer, stopMetricsServer } from "./metrics/server";
import { MinuteHandler } from "./services/minute/minuteHandler";
import { SubtitleService } from "./services/subtitle.service";
import { DynamicTracker } from "./services/tracker";
import { logger } from "./utils/logger";
import { APP_VERSION } from "./version";

async function runTracker() {
  logger.info("Starting Bilibili Video Tracker");
  logger.debug("Configuration:", config);

  // Initialize Database
  await Database.getInstance().init();
  initializeBuildInfo(APP_VERSION);
  await startMetricsServer();

  // Load all configured accounts (one per cookie file, or one legacy sessdata account)
  const accounts = loadAccounts();
  logger.info(
    `Loaded ${accounts.length} account(s): ${accounts.map((a) => a.uid).join(", ")}`,
  );

  const trackers = accounts.map((account) => new DynamicTracker(account));
  const minuteHandler = config.minute.enabled ? new MinuteHandler() : null;
  const subtitleService =
    config.subtitle.enabled && accounts.length > 0
      ? new SubtitleService(accounts[0])
      : null;
  minuteHandler?.start();
  subtitleService?.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Stopping Tracker...");
    for (const tracker of trackers) {
      tracker.stop();
    }
    if (minuteHandler) await minuteHandler.stop();
    if (subtitleService) await subtitleService.stop();
    await stopMetricsServer();
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

  if (args.includes("--init-schema")) {
    logger.info("Initializing database schema");
    const db = Database.getInstance();
    await db.init(config.database.url, { initializeSchema: true });
    await db.close();
    logger.info("Database schema initialization complete");
    return;
  }

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
  try {
    const { fatalExitsTotal } = await import("./metrics/registry");
    fatalExitsTotal.inc({ reason: "fatal_error" });
  } catch (metricsError) {
    logger.error("Failed to record fatal exit metric:", metricsError);
  }

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
