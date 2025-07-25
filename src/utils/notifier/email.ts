import nodemailer from "nodemailer";
import { config } from "../../config";
import { logger } from "../logger";

export async function sendEmailMessage(message: string) {
  if (
    !config.outputs.notification.email.host ||
    !config.outputs.notification.email.user ||
    !config.outputs.notification.email.to
  ) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.outputs.notification.email.host,
      port: config.outputs.notification.email.port || 587,
      secure: config.outputs.notification.email.port === 465,
      auth: {
        user: config.outputs.notification.email.user,
        pass: config.outputs.notification.email.pass,
      },
    });

    await transporter.sendMail({
      from: config.outputs.notification.email.from,
      to: config.outputs.notification.email.to,
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
