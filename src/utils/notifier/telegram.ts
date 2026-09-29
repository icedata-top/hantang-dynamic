import axios from "axios";
import { config } from "../../config";
import { logger } from "../logger";

const TELEGRAM_TEXT_LIMIT = 4096;
const TRUNCATION_MARKER = "\n[truncated]";

function telegramText(message: string): string {
  const codePoints = Array.from(message);
  if (codePoints.length <= TELEGRAM_TEXT_LIMIT) return message;

  return (
    codePoints
      .slice(0, TELEGRAM_TEXT_LIMIT - TRUNCATION_MARKER.length)
      .join("") + TRUNCATION_MARKER
  );
}

async function sendTelegramMessageInternal(message: string) {
  try {
    await axios.post(
      `https://${config.notifications.telegram.apiHost}/bot${config.notifications.telegram.botToken}/sendMessage`,
      {
        chat_id: config.notifications.telegram.chatId,
        text: telegramText(message),
      },
    );
  } catch (error) {
    logger.error("Failed to send telegram message:", error);
    throw error;
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
