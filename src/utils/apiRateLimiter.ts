import { config } from "../config";
import { RateLimiter } from "./rateLimiter";

export const sharedApiRateLimiter = new RateLimiter(
  config.application.concurrencyLimit || 1,
);
