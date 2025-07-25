import { z } from "zod";

export const mysqlSchema = z.object({
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  table: z.string().optional(),
  database: z.string().optional(),
});

export type MysqlConfig = z.infer<typeof mysqlSchema>;
