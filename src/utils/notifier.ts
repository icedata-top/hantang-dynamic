import { sendTelegramMessage } from "./telegram";
import { config } from "../core/config";

export async function notify(message: string) {
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    await sendTelegramMessage(message);
  } else {
    console.log(message);
  }
}
