import pino from 'pino';
import { join } from 'node:path';

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
