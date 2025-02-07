import { config } from "./core/config";
import { DynamicTracker } from "./services/tracker";
import { sleep } from "./utils/datetime";

async function main() {
  console.log("Starting Bilibili Video Tracker");
  console.log("Configuration:", JSON.stringify(config, null, 2));

  const tracker = new DynamicTracker();

  // Initial run
  await tracker.start();

  // Setup periodic execution
  const interval = setInterval(
    () => tracker.start().catch(console.error),
    config.FETCH_INTERVAL,
  );

  // Graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("Tracker stopped");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal Error:", error);
  process.exit(1);
});
