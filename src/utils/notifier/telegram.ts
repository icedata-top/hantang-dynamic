import axios from "axios";
import { config } from "../../config";
import { logger } from "../logger";

async function sendTelegramMessageInternal(message: string) {
  try {
    await axios.post(
      `https://${config.notifications.telegram.apiHost}/bot${config.notifications.telegram.botToken}/sendMessage`,
      {
        chat_id: config.notifications.telegram.chatId,
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

export async function sendTelegramWarning(message: string) {
  if (
    !config.notifications.telegram.enabled ||
    !config.notifications.telegram.warningEnabled ||
    !config.notifications.telegram.botToken ||
    !config.notifications.telegram.chatId
  ) {
    return;
  }
  await sendTelegramMessageInternal(message);
}

export async function sendTelegramNewVideo(message: string) {
  if (
    !config.notifications.telegram.enabled ||
    !config.notifications.telegram.newVideoEnabled ||
    !config.notifications.telegram.botToken ||
    !config.notifications.telegram.chatId
  ) {
    return;
  }
  await sendTelegramMessageInternal(message);
}
