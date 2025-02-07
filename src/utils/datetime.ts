export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const formatTimestamp = (ts: number) =>
  new Date(ts * 1000).toISOString();
