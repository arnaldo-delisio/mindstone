#!/usr/bin/env node
/**
 * One-time sync of cloud files to local vault
 * Usage: node sync-from-cloud.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';

// VAULT_PATH is required — set in .daemon/.env
const VAULT_PATH = process.env.VAULT_PATH;
if (!VAULT_PATH) {
  console.error('Error: VAULT_PATH environment variable is required');
  process.exit(1);
}
const USER_ID = '00000000-0000-0000-0000-000000000001';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function syncFromCloud() {
  console.log('Fetching files from cloud...');

  const { data: files, error } = await supabase
    .from('files')
    .select('path, body, frontmatter')
    .eq('user_id', USER_ID);

  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }

  console.log(`Found ${files.length} files in cloud`);

  let synced = 0;
  for (const file of files) {
    // Skip files that don't need syncing (supabase migrations, etc.)
    if (file.path.startsWith('supabase/') || file.path.startsWith('daily/')) {
      continue;
    }

    const localPath = join(VAULT_PATH, file.path);
    const dir = dirname(localPath);

    // Create directory if needed
    await mkdir(dir, { recursive: true });

    // Reconstruct markdown from frontmatter + body
    let content = file.body || '';
    if (file.frontmatter && Object.keys(file.frontmatter).length > 0) {
      content = matter.stringify(content, file.frontmatter);
    }

    await writeFile(localPath, content);
    console.log('Synced:', file.path);
    synced++;
  }

  console.log(`Done! Synced ${synced} files to ${VAULT_PATH}`);
}

syncFromCloud().catch(console.error);
