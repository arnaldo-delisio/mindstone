import writeFileAtomicPkg from 'write-file-atomic';
const writeFileAtomic = writeFileAtomicPkg;
import matter from 'gray-matter';
import { join } from 'node:path';
import { hashFile } from './hasher.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { supabase } from './supabase-client.js';
import { ConflictDetector } from './conflict-detector.js';
import { ConflictResolver } from './conflict-resolver.js';

/**
 * Downloads cloud file changes to local vault.
 * Implements conflict detection via content hash comparison to prevent data loss.
 * Implements echo detection via content hash comparison to prevent infinite sync loops.
 * Uses LRU cache for recent hash tracking.
 */
export class Downloader {
  constructor(queue) {
    this.queue = queue;
    this.recentHashes = new Map(); // Track recent hashes for echo detection
    this.maxCacheSize = 1000; // LRU limit to prevent memory leaks
    this.conflictDetector = new ConflictDetector();
    this.conflictResolver = new ConflictResolver();
  }

  /**
   * Download cloud file to local vault.
   * Detects conflicts via hash comparison before writing.
   * Detects echo events (daemon's own uploads) to prevent infinite loops.
   * Implements double-check pattern to prevent race conditions.
   */
  async downloadFile(record) {
    const { path, content_hash, frontmatter, body, updated_at } = record;

    // Skip download if body is null — file is still being processed by the backend.
    // The subsequent UPDATE event (after extraction completes) will trigger a proper download.
    if (body == null) {
      logger.info({ path }, 'Skipping download: body is null (file still processing on backend)');
      return { action: 'skipped_null_body', path };
    }

    // Skip non-markdown files — code files (.ts, .tsx, .js, .json, etc.) should never
    // be written to disk by the daemon. They can enter Supabase via MCP tools but must
    // not have YAML frontmatter injected into them.
    if (!path.endsWith('.md')) {
      logger.info({ path }, 'Skipping download: not a markdown file');
      return { action: 'skipped_not_markdown', path };
    }

    const localPath = join(config.vault.path, path);

    logger.info({ path, cloudHash: content_hash }, 'Processing cloud change');

    // Step 1: Check for conflict (pass updated_at for timestamp-based conflict detection)
    const conflictCheck = await this.conflictDetector.detectConflict(localPath, content_hash, updated_at);

    if (conflictCheck.conflict) {
      // Conflict detected: preserve local file, save cloud version to .conflict-{timestamp} file
      logger.warn({ path, ...conflictCheck }, 'Conflict detected during download');

      const cloudContent = this.reconstructMarkdown(frontmatter, body);
      await this.conflictResolver.resolveConflict(localPath, cloudContent, content_hash);

      // Local file remains unchanged
      return { action: 'conflict_created', path, conflictCheck };
    }

    // Step 2: No conflict - check if echo event
    if (conflictCheck.reason === 'hashes_match') {
      logger.debug({ path, hash: content_hash }, 'Echo event detected (hashes match), skipping download');
      return { action: 'skipped_echo', path };
    }

    // Step 3: Safe to write - reconstruct markdown from frontmatter + body
    const cloudContent = this.reconstructMarkdown(frontmatter, body);

    // Step 4: Double-check pattern - re-check for conflict right before write
    // Prevents race condition where user edits file during download process
    const recheckResult = await this.conflictDetector.detectConflict(localPath, content_hash, updated_at);
    if (recheckResult.conflict) {
      logger.warn({ path }, 'Conflict detected on recheck, aborting write');
      await this.conflictResolver.resolveConflict(localPath, cloudContent, content_hash);
      return { action: 'conflict_on_recheck', path, recheckResult };
    }

    // Write cloud content to local file (atomic write prevents corruption)
    try {
      await writeFileAtomic(localPath, cloudContent);
      logger.info({ path, localPath }, 'Cloud change written to local file');

      // Compute hash of the reconstructed content and update database
      // This prevents conflicts from gray-matter formatting differences
      const actualHash = await hashFile(localPath);

      // Update cloud hash to match local file (prevents future conflicts)
      if (actualHash !== content_hash) {
        logger.info({ path, oldHash: content_hash, newHash: actualHash }, 'Hash mismatch detected, updating cloud');

        await supabase
          .from('files')
          .update({ content_hash: actualHash })
          .eq('user_id', config.supabase.userId)
          .eq('path', path);

        logger.info({ path }, 'Cloud hash updated successfully');
      }

      // Track hash for echo detection
      this.trackHash(path, actualHash);

      return { action: 'downloaded', path, localPath };
    } catch (error) {
      logger.error({ path, error: error.message }, 'Failed to write cloud change');
      throw error;
    }
  }

  /**
   * Reconstruct markdown file from frontmatter + body.
   * Uses gray-matter to stringify frontmatter.
   * If no frontmatter, returns body only.
   */
  reconstructMarkdown(frontmatter, body) {
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      return body;
    }

    // gray-matter.stringify(content, data) format
    return matter.stringify(body, frontmatter);
  }

  /**
   * Track hash in LRU cache for echo detection.
   * Implements simple LRU eviction when cache exceeds maxCacheSize.
   */
  trackHash(path, hash) {
    // Add to cache
    this.recentHashes.set(path, hash);

    // LRU eviction: delete oldest entries if cache exceeds limit
    if (this.recentHashes.size > this.maxCacheSize) {
      const entriesToDelete = this.recentHashes.size - this.maxCacheSize;
      let deletedCount = 0;

      for (const [key] of this.recentHashes) {
        if (deletedCount >= entriesToDelete) break;
        this.recentHashes.delete(key);
        deletedCount++;
      }

      logger.debug(
        { cacheSize: this.recentHashes.size, evicted: deletedCount },
        'LRU cache eviction completed'
      );
    }
  }
}
