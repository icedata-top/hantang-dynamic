import nodemailer from "nodemailer";
import { config } from "../../config";
import { logger } from "../logger";

export async function sendEmailMessage(message: string) {
  if (
    !config.notifications.email.host ||
    !config.notifications.email.username ||
    !config.notifications.email.to
  ) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.notifications.email.host,
      port: config.notifications.email.port || 587,
      secure: config.notifications.email.port === 465,
      auth: {
        user: config.notifications.email.username,
        pass: config.notifications.email.password,
      },
    });

    await transporter.sendMail({
      from: config.notifications.email.from,
      to: config.notifications.email.to,
      subject: "Bilibili Dynamic Notification",
      html: message,
    });
    logger.info("Email sent successfully");
  } catch (error) {
    logger.error("Failed to send email message:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
  }
}
