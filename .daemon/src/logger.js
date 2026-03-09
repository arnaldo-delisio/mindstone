import pino from 'pino';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Load .env early — logger is imported before config.js runs dotenv,
// so we must load it here to get VAULT_PATH for the log file path.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// VAULT_PATH is required — validated at startup in config.js
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Transport for log rotation (production)
  transport: process.env.NODE_ENV === 'production' ? {
    target: 'pino-roll',
    options: {
      file: join(process.env.VAULT_PATH, '.sync', 'daemon.log'),
      frequency: 'daily',
      size: '10m',
      mkdir: true
    }
  } : undefined // Pretty print in development
});
