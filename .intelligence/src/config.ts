/**
 * Central configuration - env validation, constants, shared IDs
 *
 * Single source of truth for all environment and application constants.
 * Imported early by index.ts after dotenv is loaded.
 */

// Validate required environment variables
const requiredEnvVars: Array<{ key: string; description: string; example: string }> = [
  {
    key: 'SERVER_URL',
    description: 'Public Railway URL of this MCP server',
    example: 'https://mindstone-xxx.up.railway.app',
  },
  {
    key: 'DATABASE_URL',
    description: 'Supabase Postgres connection string (Transaction mode, port 6543)',
    example: 'postgresql://postgres.PROJECT:PASS@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
  },
  {
    key: 'SUPABASE_URL',
    description: 'Supabase project URL',
    example: 'https://xxxxxxxxxxxx.supabase.co',
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    description: 'Supabase service role key (Settings → API in Supabase dashboard)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  },
  {
    key: 'OAUTH_CLIENT_ID',
    description: 'OAuth client ID for MCP authentication (generate with: uuidgen)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  },
  {
    key: 'OAUTH_CLIENT_SECRET',
    description: 'OAuth client secret for MCP authentication',
    example: 'openssl rand -hex 32',
  },
  {
    key: 'OAUTH_PASSWORD_HASH',
    description: "bcrypt hash of your MCP password (generate with: node -e \"require('bcrypt').hash('yourpassword', 12).then(console.log)\")",
    example: '$2b$12$...',
  },
  {
    key: 'SESSION_SECRET',
    description: 'Express session secret (generate with: openssl rand -hex 64)',
    example: 'a8f3b2c1...',
  },
  {
    key: 'API_KEY',
    description: 'API key for PWA/HTTP clients (generate with: openssl rand -hex 32)',
    example: 'd4e5f6a7...',
  },
  {
    key: 'OPENAI_API_KEY',
    description: 'OpenAI API key for generating embeddings (1536-dim text-embedding-3-small)',
    example: 'sk-proj-...',
  },
];

const missing = requiredEnvVars.filter(({ key }) => !process.env[key]);

if (missing.length > 0) {
  console.error('\n[MindStone] Missing required environment variables:\n');
  for (const { key, description, example } of missing) {
    console.error(`  Missing: ${key}`);
    console.error(`           ${description}`);
    console.error(`           Example: ${example}\n`);
  }
  console.error('Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
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
