import axios from "axios";
import { config } from "../core/config";
import { logger } from "./logger";

export async function sendTelegramMessage(message: string) {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      },
    );
  } catch (error) {
    logger.error("Failed to send telegram message:", error);
  }
}
