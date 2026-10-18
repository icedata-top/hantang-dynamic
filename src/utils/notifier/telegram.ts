import axios from "axios";
import { config } from "../../config";
import { logger } from "../logger";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_CHUNK_LIMIT = 3900;
const ATTACHMENT_NOTE = "\n\n[full message attached as a text file]";

/**
 * Telegram captions are limited to 1024 characters, so the attachment caption
 * carries the head of the message plus a note pointing at the full file.
 */
function telegramCaption(message: string): string {
  const codePoints = Array.from(message);
  if (codePoints.length <= TELEGRAM_CAPTION_LIMIT) return message;

  return (
    codePoints
      .slice(0, TELEGRAM_CAPTION_LIMIT - ATTACHMENT_NOTE.length)
      .join("") + ATTACHMENT_NOTE
  );
}

/**
 * Split a message into chunks that fit one `sendMessage` call. This is only a
 * fallback for when the text file upload fails; newline boundaries are
 * preferred so that diagnostics stay readable.
 */
function splitTelegramText(
  message: string,
  limit = TELEGRAM_CHUNK_LIMIT,
): string[] {
  const codePoints = Array.from(message);
  const chunks: string[] = [];
  let start = 0;

  while (start < codePoints.length) {
    const end = Math.min(start + limit, codePoints.length);
    if (end === codePoints.length) {
      chunks.push(codePoints.slice(start).join(""));
      break;
    }

    const windowStart = start + Math.floor(limit * 0.75);
    let cut = -1;
    for (let i = end; i >= windowStart; i--) {
      if (codePoints[i] === "\n") {
        cut = i;
        break;
      }
    }

    const sliceEnd = cut > start ? cut : end;
    chunks.push(codePoints.slice(start, sliceEnd).join(""));
    start = cut > start ? sliceEnd + 1 : sliceEnd;
  }

  return chunks;
}

function telegramBaseUrl(): string {
  return `https://${config.notifications.telegram.apiHost}/bot${config.notifications.telegram.botToken}`;
}

async function sendTelegramText(message: string) {
  await axios.post(`${telegramBaseUrl()}/sendMessage`, {
    chat_id: config.notifications.telegram.chatId,
    text: message,
  });
}

async function sendTelegramDocument(message: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const form = new FormData();
  form.append("chat_id", config.notifications.telegram.chatId ?? "");
  form.append("caption", telegramCaption(message));
  form.append(
    "document",
    new Blob([message], { type: "text/plain;charset=utf-8" }),
    `message-${timestamp}.txt`,
  );

  await axios.post(`${telegramBaseUrl()}/sendDocument`, form);
}

async function sendTelegramMessageInternal(message: string) {
  try {
    if (Array.from(message).length <= TELEGRAM_TEXT_LIMIT) {
      await sendTelegramText(message);
      return;
    }

    // Never truncate: deliver the full message as a file instead.
    try {
      await sendTelegramDocument(message);
      return;
    } catch (error) {
      logger.warn(
        "Failed to send telegram message as a file; falling back to split messages:",
        error,
      );
    }

    for (const chunk of splitTelegramText(message)) {
      await sendTelegramText(chunk);
    }
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
