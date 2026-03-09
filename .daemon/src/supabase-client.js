import { createClient } from '@supabase/supabase-js';
import fetchRetry from 'fetch-retry';
import { config } from './config.js';

// Configure client with retry logic
const fetchWithRetry = fetchRetry(fetch, {
  retries: 3,
  retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  retryOn: [408, 413, 429, 500, 502, 503, 504, 520]
});

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    global: { fetch: fetchWithRetry },
    auth: { persistSession: false } // Daemon uses service role, no session
  }
);
