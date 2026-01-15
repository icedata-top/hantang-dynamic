import { config } from "./config";
import { Database } from "./database";
import { DynamicTracker } from "./services/tracker";
import { logger } from "./utils/logger";

async function runTracker() {
  logger.info("Starting Bilibili Video Tracker");
  logger.debug("Configuration:", config);

  // Initialize Database
  await Database.getInstance().init();

  const tracker = new DynamicTracker();

  // Initial run
  await tracker.start();

  // Setup periodic execution
  const interval = setInterval(
    () => tracker.start().catch((err) => logger.error(err)),
    config.application.fetchInterval,
  );

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Stopping Tracker...");
    clearInterval(interval);
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
}

async function main() {
  const args = process.argv.slice(2);

  // Check for tool mode
  if (args.includes("--repair")) {
    const repairIndex = args.indexOf("--repair");
    const filter = args[repairIndex + 1];
    const { runRepairVideos } = await import("./scripts/repair-videos");
    await runRepairVideos(filter);
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
