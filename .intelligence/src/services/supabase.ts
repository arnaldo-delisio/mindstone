/**
 * Shared Supabase client - single source of truth
 *
 * Uses SERVICE_ROLE_KEY (not anon key) because mindstone-intelligence is a trusted server.
 * Service role bypasses RLS - auth enforced via OAuth session / API key middleware.
 */

import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
