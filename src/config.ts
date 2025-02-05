import dotenv from 'dotenv';

dotenv.config();

interface EnvConfig {
  UID: string;
  SESSDATA: string;
  API_BASE_URL?: string;
  FETCH_INTERVAL: number;
  API_WAIT_TIME: number;
  MAX_HISTORY_DAYS: number;
}

const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const config: EnvConfig = {
  UID: requireEnvVar('UID'),
  SESSDATA: requireEnvVar('SESSDATA'),
  FETCH_INTERVAL: 15 * 60 * 1000, // 15 minutes in milliseconds
  API_WAIT_TIME: 2000, // 2 seconds in milliseconds
  MAX_HISTORY_DAYS: 7,
};

Object.freeze(config);

export default config;