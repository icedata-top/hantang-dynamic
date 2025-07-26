import { config } from "../../config";
import { logger } from "../logger";
import { sendEmailMessage } from "./email";
import { sendTelegramMessage } from "./telegram";
import { sendHttpNotification } from "./http";
import type { VideoData } from "../../core/types";

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
  [key: string]: any;
}

export async function notify(
  message: string,
  videoData?: VideoTemplateData,
): Promise<void> {
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

  if (config.notifications.http.enabled) {
    promises.push(sendHttpNotification(message, videoData));
  }

  if (promises.length === 0) {
    logger.warn(message);
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
  const promises = videos.map((video) => {
    const message =
      `🎬 发现新视频: ${video.title}\n` +
      `🔗 链接: https://www.bilibili.com/video/${video.bvid}`;

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

    return notify(message, videoData);
  });

  await Promise.all(promises);
}
