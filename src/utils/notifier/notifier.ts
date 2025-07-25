import { sendTelegramMessage } from "./telegram";
import { sendEmailMessage } from "./email";
import { config } from "../../config";
import { logger } from "../logger";

export async function notify(message: string) {
  const promises: Promise<void>[] = [];

  if (
    config.outputs.notification.telegram.botToken &&
    config.outputs.notification.telegram.chatId
  ) {
    promises.push(sendTelegramMessage(message));
  }

  if (
    config.outputs.notification.email.host &&
    config.outputs.notification.email.user &&
    config.outputs.notification.email.to
  ) {
    promises.push(sendEmailMessage(message));
  }

  if (promises.length === 0) {
    logger.warn(message);
    return;
  }

  await Promise.all(promises);
}
