import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Pino configuration: pretty print in dev, JSON in production
export const logger = pino({
  level: LOG_LEVEL,
  transport: LOG_LEVEL === 'debug' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined
});

// Child loggers for processors
export const autoTaggerLogger = logger.child({ processor: 'auto-tagger' });
export const summarizerLogger = logger.child({ processor: 'summarizer' });
export const mocGeneratorLogger = logger.child({ processor: 'moc-generator' });
export const embeddingsLogger = logger.child({ processor: 'embeddings' });
