import { logger } from "./logger";

export class RateLimiter {
  private limit: number; // Requests per second
  private queue: Array<() => void> = [];
  private activeCount = 0;
  private intervalMs = 1000;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Acquire a token to proceed.
   * If the limit is reached, the request will be queued.
   */
  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.tryAcquire(resolve);
    });
  }

  private tryAcquire(resolve: () => void) {
    if (this.activeCount < this.limit) {
      this.activeCount++;
      resolve();
      setTimeout(() => {
        this.activeCount--;
        this.processQueue();
      }, this.intervalMs);
    } else {
      this.queue.push(resolve);
    }
  }

  private processQueue() {
    if (this.queue.length > 0 && this.activeCount < this.limit) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        this.tryAcquire(nextResolve);
      }
    }
  }

  /**
   * Update the rate limit dynamically
   */
  setLimit(newLimit: number) {
    logger.info(`Updating rate limit to ${newLimit} req/s`);
    this.limit = newLimit;
    this.processQueue();
  }
}
