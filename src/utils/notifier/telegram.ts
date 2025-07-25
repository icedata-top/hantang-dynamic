import axios from "axios";
import { config } from "../../config";
import { logger } from "../logger";

export async function sendTelegramMessage(message: string) {
  if (
    !config.outputs.notification.telegram.botToken ||
    !config.outputs.notification.telegram.chatId
  ) {
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.outputs.notification.telegram.botToken}/sendMessage`,
      {
        chat_id: config.outputs.notification.telegram.chatId,
        text: message,
        parse_mode: "HTML",
      },
    );
  } catch (error) {
    logger.error("Failed to send telegram message:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
  }
}
