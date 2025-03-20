import crypto from "crypto";
import axios from "axios";
import { logger } from "../../utils/logger";
import { config } from "../../core/config";
import { StateManager } from "../../core/state";

interface BiliTicketResponse {
  code: number;
  message: string;
  data: {
    ticket: string;
    created_at: number;
    ttl: number;
    context: Record<string, any>;
    nav: {
      img: string;
      sub: string;
    };
  };
  ttl: number;
}

/**
 * Generate HMAC-SHA256 signature
 * @param key The key string to use for the HMAC-SHA256 hash
 * @param message The message string to hash
 * @returns The HMAC-SHA256 signature as a hex string
 */
function hmacSha256(key: string, message: string): string {
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(message);
  return hmac.digest("hex");
}

/**
 * Generate a BiliTicket from the API
 * @param csrf CSRF token (bili_jct) from cookies, can be empty
 * @returns The BiliTicket and its expiration timestamp
 */
export async function generateBiliTicket(csrf: string = ""): Promise<{
  ticket: string;
  expiresAt: number;
} | null> {
  try {
    const stateManager = new StateManager();
    const userAgent = stateManager.lastUA;

    const timestamp = Math.floor(Date.now() / 1000);
    const hexSign = hmacSha256("XgwSnGZ1p", `ts${timestamp}`);

    const url =
      "https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket";
    const params = {
      key_id: "ec02",
      hexsign: hexSign,
      "context[ts]": timestamp.toString(),
      csrf: csrf || config.BILI_JCT || "",
    };

    const headers: Record<string, string> = {
      "User-Agent": userAgent,
    };

    const response = await axios.post<BiliTicketResponse>(url, null, {
      params,
      headers,
    });

    if (response.data.code === 0 && response.data.data.ticket) {
      const ticket = response.data.data.ticket;
      const createdAt = response.data.data.created_at;
      const ttl = response.data.data.ttl;
      const expiresAt = createdAt + ttl;

      logger.info(
        `BiliTicket generated successfully, expires in ${Math.floor(ttl / 86400)} days`,
      );
      return { ticket, expiresAt };
    } else {
      logger.error("Failed to generate BiliTicket:", response.data);
      return null;
    }
  } catch (error) {
    logger.error("Error generating BiliTicket:", error);
    return null;
  }
}
