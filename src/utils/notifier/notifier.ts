import { sendTelegramMessage } from "./telegram";
import { sendEmailMessage } from "./email";
import { config } from "../../core/config";
import { logger } from "../logger";

export async function notify(message: string) {
  const promises: Promise<void>[] = [];

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    promises.push(sendTelegramMessage(message));
  }

  if (config.EMAIL_HOST && config.EMAIL_USER && config.EMAIL_TO) {
    promises.push(sendEmailMessage(message));
  }

  if (promises.length === 0) {
    logger.warn(message);
    return;
  }

  await Promise.all(promises);
}
