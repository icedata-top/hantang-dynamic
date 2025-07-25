import { z } from "zod";
import { mysqlSchema } from "./mysql";

export const databaseSchema = z.object({
  mysql: mysqlSchema,
  csv: z.object({
    path: z.string(),
  }),
  duckdb: z.object({
    path: z.string(),
  }),
});
