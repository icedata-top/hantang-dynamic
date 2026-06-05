import { config } from "../../config";
import { notificationsTotal } from "../../metrics/registry";
import type { VideoData } from "../../types";
import { logger } from "../logger";
import { sendEmailMessage } from "./email";
import { sendHttpNotification } from "./http";
import { sendTelegramNewVideo, sendTelegramWarning } from "./telegram";

type NotificationChannel = "telegram" | "email" | "http";

interface NotificationAttempt {
  channel: NotificationChannel;
  promise: Promise<void>;
}

function recordSettledNotifications(
  attempts: NotificationAttempt[],
  results: PromiseSettledResult<void>[],
): void {
  for (let i = 0; i < attempts.length; i++) {
    notificationsTotal.inc({
      channel: attempts[i].channel,
      result: results[i].status === "fulfilled" ? "success" : "error",
    });
  }
}

// Template data interface for video notifications
export interface VideoTemplateData {
  aid?: string;
  bvid?: string;
  title?: string;
  author?: string;
  uid?: string;
  url?: string;
  description?: string;
  tag?: string;
  [key: string]: unknown;
}

/**
 * Send a general warning notification
 */
export async function notifyWarning(
  message: string,
  videoData?: VideoTemplateData,
): Promise<void> {
  const attempts: NotificationAttempt[] = [];

  // Telegram - Uses warning logic
  if (
    config.notifications.telegram.enabled &&
    config.notifications.telegram.warningEnabled &&
    config.notifications.telegram.botToken &&
    config.notifications.telegram.chatId
  ) {
    attempts.push({
      channel: "telegram",
      promise: sendTelegramWarning(message),
    });
  }

  if (
    config.notifications.email.enabled &&
    config.notifications.email.host &&
    config.notifications.email.username &&
    config.notifications.email.to
  ) {
    attempts.push({ channel: "email", promise: sendEmailMessage(message) });
  }

  if (
    config.notifications.http.enabled &&
    config.notifications.http.endpoints.length > 0
  ) {
    attempts.push({
      channel: "http",
      promise: sendHttpNotification(message, videoData),
    });
  }

  if (attempts.length === 0) {
    logger.debug(message);
    return;
  }

  const results = await Promise.allSettled(attempts.map((a) => a.promise));
  recordSettledNotifications(attempts, results);
}

/**
 * Send notification for new video(s) discovered
 */
export async function notifyNewVideos(videos: VideoData[]): Promise<void> {
  if (videos.length === 0) return;

  // Send individual notification for each video
  const promises = videos.map(async (video) => {
    const message = `🎬 发现新视频: ${video.title} ${video.bvid}`;

    const videoData: VideoTemplateData = {
      aid: String(video.aid),
      bvid: video.bvid,
      title: video.title,
      author: String(video.user_id),
      uid: String(video.user_id),
      type: "video",
      url: `https://www.bilibili.com/video/${video.bvid}`,
      description: video.description,
      tag: video.tag,
    };

    const notificationAttempts: NotificationAttempt[] = [];

    // Telegram - Uses new video logic
    if (
      config.notifications.telegram.enabled &&
      config.notifications.telegram.newVideoEnabled &&
      config.notifications.telegram.botToken &&
      config.notifications.telegram.chatId
    ) {
      notificationAttempts.push({
        channel: "telegram",
        promise: sendTelegramNewVideo(message),
      });
    }

    // Email
    if (
      config.notifications.email.enabled &&
      config.notifications.email.host &&
      config.notifications.email.username &&
      config.notifications.email.to
    ) {
      notificationAttempts.push({
        channel: "email",
        promise: sendEmailMessage(message),
      });
    }

    // HTTP
    if (
      config.notifications.http.enabled &&
      config.notifications.http.endpoints.length > 0
    ) {
      notificationAttempts.push({
        channel: "http",
        promise: sendHttpNotification(message, videoData),
      });
    }

    if (notificationAttempts.length > 0) {
      const results = await Promise.allSettled(
        notificationAttempts.map((a) => a.promise),
      );
      recordSettledNotifications(notificationAttempts, results);
    } else {
      logger.debug(message);
    }
  });

  await Promise.all(promises);
}
