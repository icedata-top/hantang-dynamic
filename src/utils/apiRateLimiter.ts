import { config } from "../config";
import { RateLimiter } from "./rateLimiter";

export const sharedApiRateLimiter = new RateLimiter(
  config.application.concurrencyLimit || 1,
);

/**
 * Recommendation detail collection has its own shared API capacity. Callers
 * that expand recommendation cards (manual refresh and minute gates) use this
 * limiter so source, import, and bridge requests share the same 20 slots.
 */
export const sharedRecommendationApiRateLimiter = new RateLimiter(20);
