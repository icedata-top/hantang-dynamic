import { processFollows } from "../utils/follow";
import { logger } from "../utils/logger";

// Get command line arguments
const args = process.argv.slice(2);
const csvPath = args[0]; // First argument is the CSV path (optional)
const batchSize = args[1] ? parseInt(args[1], 10) : 50; // Second argument is batch size (default: 5)
const waitTime = args[2] ? parseInt(args[2], 10) : 40000; // Third argument is wait time (default: 40s)

async function main() {
  logger.info("Starting batch follow process");
  logger.info(`Parameters: CSV=${csvPath || "data/follow.csv"}, Batch Size=${batchSize}, Wait Time=${waitTime}ms`);
  
  try {
    await processFollows(csvPath, batchSize, waitTime);
  } catch (error) {
    logger.error("Unexpected error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    process.exit(1);
  }
}

main();