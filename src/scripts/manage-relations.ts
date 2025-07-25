import * as readline from "readline";
import { UserRelationAction } from "../api/relation";
import { logger } from "../utils/logger";
import { UserRelationManager } from "../utils/relationManager";

/**
 * Display help information
 */
function showHelp() {
  console.log("User Relation Manager");
  console.log("Usage: npm run relations [options]");
  console.log("\nOptions:");
  console.log(
    "  action=<action>     Action to perform (follow, unfollow, block, unblock, remove)",
  );
  console.log("  csv=<path>          Path to CSV file with user IDs");
  console.log("  batch=<size>        Batch size (default: 50)");
  console.log(
    "  wait=<ms>           Wait time in milliseconds between batches (default: 40000)",
  );
  console.log("\nExamples:");
  console.log(
    "  npm run relations action=follow csv=./data/custom-follows.csv batch=20 wait=30000",
  );
  console.log("  npm run relations action=unfollow");
  console.log(
    "\nIf no options are provided, the script will run in interactive mode.",
  );
}

/**
 * Parse CLI arguments into an options object
 */
function parseArgs(): {
  action?: UserRelationAction;
  csvPath?: string;
  batchSize: number;
  waitTime: number;
} {
  const options = {
    action: undefined as UserRelationAction | undefined,
    csvPath: undefined as string | undefined,
    batchSize: 50,
    waitTime: 40000,
  };

  // Check if help is requested
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // Parse arguments in format key=value
  process.argv.slice(2).forEach((arg) => {
    if (arg.includes("=")) {
      const [key, value] = arg.split("=");

      if (key === "action") {
        switch (value.toLowerCase()) {
          case "follow":
            options.action = UserRelationAction.Follow;
            break;
          case "unfollow":
            options.action = UserRelationAction.Unfollow;
            break;
          case "block":
            options.action = UserRelationAction.Block;
            break;
          case "unblock":
            options.action = UserRelationAction.Unblock;
            break;
          case "remove":
            options.action = UserRelationAction.RemoveFollower;
            break;
          default:
            logger.warn(
              `Unknown action: ${value}, will run in interactive mode`,
            );
        }
      } else if (key === "csv") {
        options.csvPath = value;
      } else if (key === "batch") {
        options.batchSize = parseInt(value, 10);
      } else if (key === "wait") {
        options.waitTime = parseInt(value, 10);
      }
    }
  });

  return options;
}

/**
 * Create readline interface for interactive mode
 */
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask user a question and return the answer
 */
async function question(
  rl: readline.Interface,
  query: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive mode to ask for all necessary parameters
 */
async function runInteractiveMode(): Promise<{
  action: UserRelationAction;
  csvPath?: string;
  batchSize: number;
  waitTime: number;
}> {
  const rl = createReadlineInterface();

  console.log("\n=== User Relation Manager ===\n");
  console.log("Select an action to perform:");
  console.log("1. Follow users");
  console.log("2. Unfollow users");
  console.log("3. Block users");
  console.log("4. Unblock users");
  console.log("5. Remove followers");

  // Get action
  let actionChoice = "";
  while (!["1", "2", "3", "4", "5"].includes(actionChoice)) {
    actionChoice = await question(rl, "Enter your choice (1-5): ");
  }

  const actionMap: Record<string, UserRelationAction> = {
    "1": UserRelationAction.Follow,
    "2": UserRelationAction.Unfollow,
    "3": UserRelationAction.Block,
    "4": UserRelationAction.Unblock,
    "5": UserRelationAction.RemoveFollower,
  };

  const action = actionMap[actionChoice];
  const actionName = UserRelationManager.getActionName(action);
  const defaultFilename = UserRelationManager.getDefaultFilename(action);

  // Get CSV path
  const defaultPath = `./data/${defaultFilename}`;
  const csvInput = await question(rl, `Enter CSV path [${defaultPath}]: `);
  const csvPath = csvInput || defaultPath;

  // Get batch size
  const batchInput = await question(rl, "Enter batch size [50]: ");
  const batchSize = parseInt(batchInput, 10) || 50;

  // Get wait time
  const waitInput = await question(
    rl,
    "Enter wait time between batches in ms [40000]: ",
  );
  const waitTime = parseInt(waitInput, 10) || 40000;

  console.log("\nConfiguration:");
  console.log(`- Action: ${actionName}`);
  console.log(`- CSV Path: ${csvPath}`);
  console.log(`- Batch Size: ${batchSize}`);
  console.log(`- Wait Time: ${waitTime}ms`);

  const confirm = await question(
    rl,
    "\nProceed with this configuration? (Y/n): ",
  );

  rl.close();

  if (confirm.toLowerCase() === "n") {
    logger.info("Operation cancelled by user");
    process.exit(0);
  }

  return { action, csvPath, batchSize, waitTime };
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Parse CLI arguments
    const options = parseArgs();

    // If action is not specified, run interactive mode
    if (options.action === undefined) {
      const interactiveOptions = await runInteractiveMode();
      options.action = interactiveOptions.action;
      options.csvPath = interactiveOptions.csvPath;
      options.batchSize = interactiveOptions.batchSize;
      options.waitTime = interactiveOptions.waitTime;
    }

    // Log the operation details
    const actionName = UserRelationManager.getActionName(options.action);
    logger.info(`Starting batch ${actionName} process`);
    logger.info(
      `Parameters: Action=${actionName}, CSV=${options.csvPath || `data/${UserRelationManager.getDefaultFilename(options.action)}`}, Batch Size=${options.batchSize}, Wait Time=${options.waitTime}ms`,
    );

    // Run the appropriate action
    await UserRelationManager.processUserRelations(
      options.action,
      options.csvPath,
      options.batchSize,
      options.waitTime,
    );
  } catch (error) {
    logger.error("Unexpected error:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    process.exit(1);
  }
}

// Start the application
main();
