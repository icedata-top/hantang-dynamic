import type { AxiosInstance } from "axios";
import type { CookieJar } from "tough-cookie";
import {
  createAccountDynamicClient,
  createAccountPlayerClient,
  createAccountRelationClient,
  createAccountToViewClient,
  createAccountWebInterfaceClient,
  dynamicClient as globalDynamicClient,
  playerDirectClient as globalPlayerClient,
  relationClient as globalRelationClient,
  toViewClient as globalToViewClient,
  webInterfaceDirectClient as globalWebInterfaceClient,
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
  /** Whether this loaded cookie account participates in Watch Later sampling. */
  enableWatchLater: boolean;
  /** Per-account state manager (state file named by uid when using cookie files) */
  stateManager: StateManager;
  /** Authenticated dynamic API client for this account */
  dynamicClient: AxiosInstance;
  /** Authenticated direct web-interface client for this account */
  webInterfaceClient: AxiosInstance;
  /** Authenticated direct player client for this account */
  playerClient: AxiosInstance;
  /** Authenticated relation client for this account */
  relationClient: AxiosInstance;
  /** Authenticated To View client for this account */
  toViewClient: AxiosInstance;
}

let _accounts: AccountContext[] | null = null;

export function loadCookieFileAccount(cookieFile: {
  path: string;
  enableWatchLater: boolean;
}): AccountContext | null {
  const { path: filePath, enableWatchLater } = cookieFile;
  try {
    const cookies = parseNetscapeCookieFile(filePath);
    const jar = createCookieJarFromNetscape(cookies);

    const uid = getDedeUserIDFromCookieFile(filePath) ?? "";
    if (!/^\d+$/.test(uid)) {
      throw new Error(
        `Cannot determine uid for cookie file: ${filePath}. ` +
          "No numeric DedeUserID cookie found.",
      );
    }

    // Each account has its own state file to track position independently
    const stateManager = new StateManager(`./state_${uid}.json`);
    const accountLabel = `uid=${uid}`;

    const client = createAccountDynamicClient(
      "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr",
      jar,
      filePath,
      stateManager,
      accountLabel,
    );
    const webInterfaceClient = createAccountWebInterfaceClient(
      jar,
      filePath,
      stateManager,
      accountLabel,
    );
    const playerClient = createAccountPlayerClient(
      jar,
      filePath,
      stateManager,
      accountLabel,
    );
    const relationClient = createAccountRelationClient(
      jar,
      filePath,
      stateManager,
      accountLabel,
    );
    const toViewClient = createAccountToViewClient(
      jar,
      filePath,
      stateManager,
      accountLabel,
    );

    logger.info(`Loaded account uid=${uid} from ${filePath}`);
    return {
      uid,
      cookieJar: jar,
      cookieFilePath: filePath,
      enableWatchLater,
      stateManager,
      dynamicClient: client,
      webInterfaceClient,
      playerClient,
      relationClient,
      toViewClient,
    };
  } catch (error) {
    logger.error(
      `Failed to load account from ${filePath}; skipping it.`,
      error,
    );
    return null;
  }
}

/**
 * Load all configured accounts.
 *
 * - When `cookie_files` (or `cookie_file`) is set, each file becomes one account.
 *   The uid is extracted from the `DedeUserID` cookie in the file.
 * - When only `sessdata` is configured (legacy mode), a single account is created
 *   using the uid from config and the global dynamic client.
 *
 * Results are cached so this is safe to call multiple times.
 */
export function loadAccounts(): AccountContext[] {
  if (_accounts) return _accounts;

  const cookieFiles = config.bilibili.cookieFiles;

  if (cookieFiles.length > 0) {
    _accounts = cookieFiles
      .map(loadCookieFileAccount)
      .filter((account): account is AccountContext => account !== null);

    if (_accounts.length === 0) {
      logger.warn(
        "No valid cookie-file accounts were loaded; authenticated tracker tasks will not start.",
      );
    }
  } else {
    // Legacy: sessdata mode — single account using config uid and global client
    const uid = config.bilibili.uid ?? "";
    _accounts = [
      {
        uid,
        cookieJar: null,
        cookieFilePath: null,
        enableWatchLater: false,
        stateManager: new StateManager("./state.json"),
        dynamicClient: globalDynamicClient,
        webInterfaceClient: globalWebInterfaceClient,
        playerClient: globalPlayerClient,
        relationClient: globalRelationClient,
        toViewClient: globalToViewClient,
      },
    ];
  }

  return _accounts;
}
