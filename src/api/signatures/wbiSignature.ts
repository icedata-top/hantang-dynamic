import crypto from "crypto";
import axios from "axios";
import { logger } from "../../utils/logger";
import { StateManager } from "../../core/state";
import { config } from "../../core/config";

// Mixing key encoding table for WBI signature
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/**
 * Get mixin key by scrambling img_key and sub_key
 * @param orig Combined string of img_key and sub_key
 * @returns The scrambled mixin_key
 */
function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n])
    .join("")
    .slice(0, 32);
}

/**
 * Fetch WBI keys from Bilibili API
 * @returns The img_key and sub_key
 */
async function fetchWbiKeys(
  stateManager: StateManager
): Promise<{ imgKey: string; subKey: string }> {
  try {
    const userAgent = stateManager.lastUA;

    const url = "https://api.bilibili.com/x/web-interface/nav";
    const headers: Record<string, string> = {
      "User-Agent": userAgent,
    };

    // Add SESSDATA if available
    if (config.SESSDATA) {
      headers.Cookie = `SESSDATA=${config.SESSDATA}`;
    }

    const response = await axios.get(url, { headers });

    if (response.data?.code === 0 && response.data?.data?.wbi_img) {
      const imgUrl = response.data.data.wbi_img.img_url;
      const subUrl = response.data.data.wbi_img.sub_url;

      const imgKey = imgUrl.substring(
        imgUrl.lastIndexOf("/") + 1,
        imgUrl.lastIndexOf(".")
      );
      const subKey = subUrl.substring(
        subUrl.lastIndexOf("/") + 1,
        subUrl.lastIndexOf(".")
      );

      // Keys are valid for 8 hours
      const expiresAt = Math.floor(Date.now() / 1000) + 8 * 60 * 60;

      // Update the state
      stateManager.updateWbiKeys(imgKey, subKey, expiresAt);

      logger.info("WBI keys fetched successfully, valid for 8 hours");
      return { imgKey, subKey };
    } else {
      logger.error("Invalid response when fetching WBI keys", response.data);
      throw new Error("Failed to fetch WBI keys");
    }
  } catch (error) {
    logger.error("Error fetching WBI keys:", error);
    throw error;
  }
}

/**
 * Get WBI keys, from state or fetch new ones
 * @returns Valid WBI keys
 */
async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  let stateManager = new StateManager();
  if (stateManager.isWbiKeysValid()) {
    return {
      imgKey: stateManager.imgKey!,
      subKey: stateManager.subKey!,
    };
  }

  // Fetch new keys
  return await fetchWbiKeys(stateManager);
}

/**
 * Sign parameters with WBI signature
 * @param params Parameters to sign
 * @returns Parameters with WBI signature added
 */
export async function signWithWbi<T extends Record<string, any>>(
  params: T
): Promise<T & { w_rid: string; wts: number }> {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);

  // Add timestamp
  const wts = Math.floor(Date.now() / 1000);
  const paramsWithWts = { ...params, wts };

  // Sort and filter parameters
  const sortedParams = Object.keys(paramsWithWts)
    .sort()
    .reduce<Record<string, any>>((acc, key) => {
      // Filter out special characters from values
      const value = String(paramsWithWts[key]).replace(/[!'()*]/g, "");
      acc[key] = value;
      return acc;
    }, {});

  // Build query string
  const query = Object.entries(sortedParams)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");

  // Calculate MD5 hash for w_rid
  const md5Hash = crypto.createHash("md5");
  md5Hash.update(query + mixinKey);
  const w_rid = md5Hash.digest("hex");

  return { ...params, w_rid, wts };
}

/**
 * Build a signed query string
 * @param params Parameters to sign
 * @returns Query string with WBI signature
 */
export async function buildSignedQuery(
  params: Record<string, any>
): Promise<string> {
  const signedParams = await signWithWbi(params);

  return Object.entries(signedParams)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
}
