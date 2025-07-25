import { emailSchema } from "./email";
import { telegramSchema } from "./telegram";
import { z } from "zod";

export const notificationSchema = z.object({
  email: emailSchema,
  telegram: telegramSchema,
});
