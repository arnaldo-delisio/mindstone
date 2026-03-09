import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

// Load .env file
loadEnv();

// Validate required environment variables
const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VAULT_PATH'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // Single-user vault: use fixed user ID (service role bypasses RLS)
    userId: process.env.VAULT_USER_ID || '00000000-0000-0000-0000-000000000001',
  },
  vault: {
    path: process.env.VAULT_PATH,
    syncDir: join(process.env.VAULT_PATH, '.sync'),
    queuePath: join(process.env.VAULT_PATH, '.sync', 'queue.json'),
    healthPath: join(process.env.VAULT_PATH, '.sync', 'health.json'),
    sessionLogPath: join(process.env.VAULT_PATH, '.sync', 'session.json'),
  },
  daemon: {
    maxFileSize: 5 * 1024 * 1024, // 5MB per SYNC-08
    stabilityThreshold: 50, // 50ms for markdown files per RESEARCH.md Pattern 1
    pollInterval: 10, // Poll every 10ms during awaitWriteFinish
  },
  retry: {
    maxRetries: 10,
    minTimeout: 1000,
    maxTimeout: 60000,
    maxRetryTime: 600000, // 10 minutes total
  },
  queue: {
    concurrency: 3,
    intervalCap: 30,
    interval: 60000, // 30 ops per 60 seconds (Supabase free tier safety)
  },
  reconciliation: {
    // Default to 24 hours if not specified
    interval: parseInt(process.env.RECONCILIATION_INTERVAL) || 86400000, // 24 hours in ms
  },
};
