import { z } from "zod";
import { databaseSchema } from "./database";
import { notificationSchema } from "./notification";

export const outputsSchema = z.object({
  database: databaseSchema,
  notification: notificationSchema,
});
