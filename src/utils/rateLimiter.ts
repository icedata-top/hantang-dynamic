import { logger } from "./logger";

/**
 * ConcurrencyLimiter - Limits the number of concurrent operations
 * Unlike a rate limiter (requests per time), this limits simultaneous operations
 */
export class RateLimiter {
  private limit: number; // Maximum concurrent operations
  private queue: Array<() => void> = [];
  private activeCount = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Acquire a slot to proceed.
   * If the limit is reached, the request will be queued.
   * Must call release() after the operation completes.
   */
  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.tryAcquire(resolve);
    });
  }

  private tryAcquire(resolve: (release: () => void) => void) {
    if (this.activeCount < this.limit) {
      this.activeCount++;
      // Return a release function
      resolve(() => this.release());
    } else {
      this.queue.push(() => this.tryAcquire(resolve));
    }
  }

  private release() {
    this.activeCount--;
    this.processQueue();
  }

  private processQueue() {
    if (this.queue.length > 0 && this.activeCount < this.limit) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        nextResolve();
      }
    }
  }

  /**
   * Update the concurrency limit dynamically
   */
  setLimit(newLimit: number) {
    logger.info(`Updating concurrency limit to ${newLimit}`);
    this.limit = newLimit;
    this.processQueue();
  }

  /**
   * Get current active count
   */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}
