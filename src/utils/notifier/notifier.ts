import { sendTelegramMessage } from "./telegram";
import { sendEmailMessage } from "./email";
import { config } from "../../config";
import { logger } from "../logger";

export async function notify(message: string) {
  const promises: Promise<void>[] = [];

  if (
    config.notifications.telegram.botToken &&
    config.notifications.telegram.chatId
  ) {
    promises.push(sendTelegramMessage(message));
  }

  if (
    config.notifications.email.host &&
    config.notifications.email.username &&
    config.notifications.email.to
  ) {
    promises.push(sendEmailMessage(message));
  }

  if (promises.length === 0) {
    logger.warn(message);
    return;
  }

  await Promise.all(promises);
}
