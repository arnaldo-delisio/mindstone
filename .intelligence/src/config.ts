/**
 * Central configuration - env validation, constants, shared IDs
 *
 * Single source of truth for all environment and application constants.
 * Imported early by index.ts after dotenv is loaded.
 */

// Validate required environment variables
const requiredEnvVars = [
  'SERVER_URL',
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_PASSWORD_HASH',
  'SESSION_SECRET',
  'API_KEY',
  'OPENAI_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Single-user system
export const USER_ID = '00000000-0000-0000-0000-000000000001';

// Queue configuration
const ALLOW_PROD_QUEUES = process.env.ALLOW_PROD_QUEUES === 'true';
export const EXTRACTION_QUEUE = ALLOW_PROD_QUEUES ? 'extraction_queue' : 'test_extraction_queue';
export const INTELLIGENCE_QUEUE = ALLOW_PROD_QUEUES ? 'intelligence_queue' : 'test_intelligence_queue';
export const EMBEDDINGS_QUEUE = ALLOW_PROD_QUEUES ? 'embeddings_queue' : 'test_embeddings_queue';
export const VISIBILITY_TIMEOUT = 300; // 5 minutes
export const MAX_RETRIES = 3;
export const POLL_INTERVAL = 30000; // 30 seconds
export const EMBEDDINGS_BATCH_SIZE = 20;
export { ALLOW_PROD_QUEUES };

// OAuth configuration
export const oauthConfig = {
  serverUrl: process.env.SERVER_URL!,
  database: process.env.DATABASE_URL!,
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  passwordHash: process.env.OAUTH_PASSWORD_HASH!,
  sessionSecret: process.env.SESSION_SECRET!,
  apiKey: process.env.API_KEY!,
  sessionMaxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  allowedRedirectPrefixes: [
    'https://claude.ai',
    'https://claude.com',
    process.env.SERVER_URL! // Allow PWA redirects
  ]
};

// Server
export const PORT = parseInt(process.env.PORT || '3000', 10);

// Reminder pipeline
export const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_URL || process.env.SERVER_URL!;
