import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { hashFile } from './hasher.js';
import { parseMarkdownFile } from './parser.js';
import { supabase } from './supabase-client.js';
import { logger } from './logger.js';
import { config } from './config.js';

export async function syncFile(filePath) {
  // Only sync markdown files — safety net for any non-.md that slips past watcher filters
  if (!filePath.endsWith('.md')) {
    logger.debug({ filePath }, 'Skipping non-markdown file');
    return { skipped: true, reason: 'not_markdown' };
  }

  try {
    // Check file size before processing (SYNC-08 + Pitfall 8)
    const stats = await stat(filePath);

    if (stats.size > config.daemon.maxFileSize) {
      logger.warn(
        { filePath, size: stats.size, limit: config.daemon.maxFileSize },
        'File exceeds size limit, skipping sync'
      );
      return { skipped: true, reason: 'size_limit' };
    }

    // Hash file content (SYNC-02)
    const contentHash = await hashFile(filePath);

    // Parse markdown with frontmatter (ORG-02)
    const parsed = await parseMarkdownFile(filePath);

    if (parsed._malformed) {
      logger.warn({ filePath }, 'File synced with malformed frontmatter');
    }

    // Get relative path from vault root
    const relativePath = relative(config.vault.path, filePath);

    // Upsert to Supabase (SYNC-03 + Pattern 5)
    // Note: Using service role key which bypasses RLS, so user_id is just for data organization
    const { data, error } = await supabase
      .from('files')
      .upsert(
        {
          user_id: config.supabase.userId,
          path: relativePath,
          content_hash: contentHash,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          size_bytes: stats.size,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id,path',  // Must match unique constraint from 01-01
          ignoreDuplicates: false       // Always update on conflict
        }
      )
      .select('id');

    if (error) throw error;

    logger.info({ filePath, contentHash }, 'File synced successfully');

    return { synced: true, contentHash, data };

  } catch (error) {
    // Handle file not found gracefully - file was deleted after being queued
    if (error.code === 'ENOENT') {
      logger.info({ filePath }, 'File no longer exists, skipping sync');
      return { skipped: true, reason: 'file_not_found' };
    }

    logger.error({ filePath, error: error.message }, 'Failed to sync file');
    // Don't add to retry queue here - that's handled by retry-queue.js in Plan 04
    throw error; // Propagate for caller to handle
  }
}
