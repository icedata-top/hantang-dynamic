import { config } from "./core/config";
import { DynamicTracker } from "./services/tracker";
import { sleep } from "./utils/datetime";
import { logger } from "./utils/logger";

async function main() {
  logger.info("Starting Bilibili Video Tracker");
  logger.debug("Configuration:", config);

  const tracker = new DynamicTracker();

  // Initial run
  await tracker.start();

  // Setup periodic execution
  const interval = setInterval(
    () => tracker.start().catch((err) => logger.error(err)),
    config.FETCH_INTERVAL,
  );

  // Graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(interval);
    logger.info("Tracker stopped");
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Fatal Error:", error);
  process.exit(1);
});
