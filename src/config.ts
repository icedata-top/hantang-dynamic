import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Interface for environment variables
interface EnvConfig {
  UID: string;
  SESSDATA: string;
  API_BASE_URL?: string;
}

// Validate required environment variables
const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

// Configuration object
const config: EnvConfig = {
  UID: requireEnvVar('UID'),
  SESSDATA: requireEnvVar('SESSDATA'),
};

// Freeze configuration to prevent modifications
Object.freeze(config);

export default config;