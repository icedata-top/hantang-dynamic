import nodemailer from "nodemailer";
import { config } from "../../core/config";
import { logger } from "../logger";

export async function sendEmailMessage(message: string) {
  if (!config.EMAIL_HOST || !config.EMAIL_USER || !config.EMAIL_TO) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.EMAIL_HOST,
      port: config.EMAIL_PORT || 587,
      secure: config.EMAIL_PORT === 465,
      auth: {
        user: config.EMAIL_USER,
        pass: config.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: config.EMAIL_FROM || config.EMAIL_USER,
      to: config.EMAIL_TO,
      subject: "Bilibili Dynamic Notification",
      html: message,
    });
    logger.info("Email sent successfully");
  } catch (error) {
    logger.error("Failed to send email message:", error);
  }
}
