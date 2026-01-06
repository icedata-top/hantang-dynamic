import { config } from "./config";
import { Database } from "./core/database";
import { DynamicTracker } from "./services/tracker";
import { logger } from "./utils/logger";

async function main() {
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
