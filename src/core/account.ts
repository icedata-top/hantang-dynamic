import type { AxiosInstance } from "axios";
import type { CookieJar } from "tough-cookie";
import {
  createAccountDynamicClient,
  dynamicClient as globalDynamicClient,
} from "../api/client";
import { config } from "../config";
import {
  createCookieJarFromNetscape,
  getDedeUserIDFromCookieFile,
  parseNetscapeCookieFile,
} from "../utils/cookieFile";
import { logger } from "../utils/logger";
import { StateManager } from "./state";

export interface AccountContext {
  /** Bilibili UID for this account (extracted from DedeUserID cookie, or from config) */
  uid: string;
  /** Cookie jar for this account (null in sessdata/legacy mode) */
  cookieJar: CookieJar | null;
  /** Path to the cookie file this account was loaded from (null in sessdata/legacy mode) */
  cookieFilePath: string | null;
  /** Per-account state manager (state file named by uid when using cookie files) */
  stateManager: StateManager;
  /** Authenticated dynamic API client for this account */
  dynamicClient: AxiosInstance;
}

let _accounts: AccountContext[] | null = null;

/**
 * Load all configured accounts.
 *
 * - When `cookie_files` (or `cookie_file`) is set, each file becomes one account.
 *   The uid is extracted from the `DedeUserID` cookie in the file; the `uid`
 *   setting in config is ignored.
 * - When only `sessdata` is configured (legacy mode), a single account is created
 *   using the uid from config and the global dynamic client.
 *
 * Results are cached so this is safe to call multiple times.
 */
export function loadAccounts(): AccountContext[] {
  if (_accounts) return _accounts;

  const cookieFiles = config.bilibili.cookieFiles;

  if (cookieFiles.length > 0) {
    _accounts = cookieFiles.map((filePath) => {
      const cookies = parseNetscapeCookieFile(filePath);
      const jar = createCookieJarFromNetscape(cookies);

      const uid =
        getDedeUserIDFromCookieFile(filePath) ?? config.bilibili.uid ?? "";
      if (!uid) {
        throw new Error(
          `Cannot determine uid for cookie file: ${filePath}. ` +
            "No DedeUserID cookie found and no uid set in config.",
        );
      }

      // Each account has its own state file to track position independently
      const stateManager = new StateManager(`./state_${uid}.json`);

      const client = createAccountDynamicClient(
        "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
        jar,
        filePath,
        stateManager,
      );

      logger.info(`Loaded account uid=${uid} from ${filePath}`);
      return {
        uid,
        cookieJar: jar,
        cookieFilePath: filePath,
        stateManager,
        dynamicClient: client,
      };
    });
  } else {
    // Legacy: sessdata mode — single account using config uid and global client
    const uid = config.bilibili.uid ?? "";
    _accounts = [
      {
        uid,
        cookieJar: null,
        cookieFilePath: null,
        stateManager: new StateManager("./state.json"),
        dynamicClient: globalDynamicClient,
      },
    ];
  }

  return _accounts;
}
