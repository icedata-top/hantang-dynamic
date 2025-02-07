export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const formatTimestamp = (ts: number) =>
  new Date(ts * 1000).toISOString();

const DEFAULT_RETRY_TIMES = 3;
const DEFAULT_RETRY_DELAY = 1000;

export const retryDelay = async <T>(
  fn: () => Promise<T>, 
  retries = DEFAULT_RETRY_TIMES,
  delay = DEFAULT_RETRY_DELAY
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await sleep(delay);
    return retryDelay(fn, retries - 1, delay);
  }
};