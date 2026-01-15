import { config } from "../../config";
import type { VideoData } from "../../types";
import { logger } from "../logger";
import { sendEmailMessage } from "./email";
import { sendHttpNotification } from "./http";
import { sendTelegramNewVideo, sendTelegramWarning } from "./telegram";

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
  const promises: Promise<void>[] = [];

  // Telegram - Uses warning logic
  promises.push(sendTelegramWarning(message));

  if (
    config.notifications.email.enabled &&
    config.notifications.email.host &&
    config.notifications.email.username &&
    config.notifications.email.to
  ) {
    promises.push(sendEmailMessage(message));
  }

  if (config.notifications.http.enabled) {
    promises.push(sendHttpNotification(message, videoData));
  }

  if (promises.length === 0) {
    logger.debug(message);
    return;
  }

  await Promise.all(promises);
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

    const notificationPromises: Promise<void>[] = [];

    // Telegram - Uses new video logic
    notificationPromises.push(sendTelegramNewVideo(message));

    // Email
    if (
      config.notifications.email.enabled &&
      config.notifications.email.host &&
      config.notifications.email.username &&
      config.notifications.email.to
    ) {
      notificationPromises.push(sendEmailMessage(message));
    }

    // HTTP
    if (config.notifications.http.enabled) {
      notificationPromises.push(sendHttpNotification(message, videoData));
    }

    if (notificationPromises.length > 0) {
      await Promise.all(notificationPromises);
    } else {
      logger.debug(message);
    }
  });

  await Promise.all(promises);
}
