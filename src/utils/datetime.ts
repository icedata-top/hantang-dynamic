/**
 * Sleep for a specified number of milliseconds
 * @param ms Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const formatTimestamp = (ts: number) =>
  new Date(ts * 1000).toISOString();

/**
 * Get a random delay in milliseconds within the specified range
 * @param min Minimum delay in milliseconds
 * @param max (Optional) Maximum delay in milliseconds
 * @returns Random delay in milliseconds
 */
export const getRandomDelay = (min: number, max?: number): number => {
  if (max === undefined) {
    return Math.floor(min * (0.5 + Math.random()));
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const DEFAULT_RETRY_TIMES = 3;
const DEFAULT_RETRY_DELAY = 1000;

export const retryDelay = async <T>(
  fn: () => Promise<T>,
  retries = DEFAULT_RETRY_TIMES,
  delay = DEFAULT_RETRY_DELAY,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await sleep(delay);
    return retryDelay(fn, retries - 1, delay);
  }
};
