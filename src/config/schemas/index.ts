// Re-export all schema types for easy importing
export type { BilibiliConfig } from "./bilibili";

export type { ApplicationConfig } from "./application";

export type { ProcessingConfig } from "./processing";

export type {
  ExportConfig,
  CsvConfig,
  DuckdbConfig,
  MysqlConfig,
} from "./export";

export type {
  NotificationsConfig,
  EmailConfig,
  TelegramConfig,
} from "./notifications";

// Re-export all schemas
export { bilibiliSchema } from "./bilibili";
export { applicationSchema } from "./application";
export { processingSchema } from "./processing";
export { exportSchema } from "./export";
export { notificationsSchema } from "./notifications";
