import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { hashFile } from './hasher.js';
import { logger } from './logger.js';

/**
 * Detects conflicts between local and cloud versions using content hash comparison.
 * Prevents data loss from simultaneous edits by comparing hashes before overwriting.
 */
export class ConflictDetector {
  /**
   * Detect if a conflict exists between local file and cloud version.
   *
   * @param {string} localPath - Absolute path to local file
   * @param {string} cloudHash - SHA-256 hash from cloud (hex string)
   * @param {string} cloudUpdatedAt - ISO timestamp of cloud update (optional)
   * @returns {Promise<Object>} Conflict detection result
   *   - { conflict: false, reason: 'hashes_match' } - Echo event, skip download
   *   - { conflict: false, reason: 'local_missing' } - New file from cloud
   *   - { conflict: false, reason: 'local_older' } - Local file older than cloud, replace
   *   - { conflict: true, reason: 'content_differs', localHash, cloudHash } - Conflict detected
   *   - { conflict: true, reason: 'hash_length_differs', localHash, cloudHash } - Hash mismatch
   */
  async detectConflict(localPath, cloudHash, cloudUpdatedAt) {
    // Special case: blank content_hash means "always download, no conflict"
    // Used by Edge Functions that generate content (MOCs, etc.) where hash will be computed by daemon after download
    if (!cloudHash || cloudHash === '') {
      logger.debug({ localPath }, 'Blank cloud hash detected, safe to download (no conflict)');
      return { conflict: false, reason: 'blank_cloud_hash' };
    }

    try {
      // Check if file exists locally and get stats
      const localStats = await stat(localPath);

      // Hash local file content (streaming for memory efficiency)
      const localHash = await hashFile(localPath);

      // Compare hashes securely using constant-time comparison
      // Prevents timing attacks (though low risk for this use case)
      const localBuffer = Buffer.from(localHash, 'hex');
      const cloudBuffer = Buffer.from(cloudHash, 'hex');

      try {
        // timingSafeEqual throws if buffers have different lengths
        const hashesMatch = timingSafeEqual(localBuffer, cloudBuffer);

        if (hashesMatch) {
          logger.debug({ localPath, hash: localHash }, 'Hashes match, no conflict (echo event)');
          return { conflict: false, reason: 'hashes_match' };
        }

        // Hashes differ - check timestamps to distinguish conflict from cloud update
        if (cloudUpdatedAt) {
          const localMtime = localStats.mtime;
          const cloudTime = new Date(cloudUpdatedAt);

          // If local file is older than cloud update, user hasn't edited it
          // Cloud is authoritative (e.g., intelligence updates) - no conflict, just replace
          if (localMtime < cloudTime) {
            logger.info({
              localPath,
              localTime: localMtime.toISOString(),
              cloudTime: cloudTime.toISOString()
            }, 'Local file older than cloud, replacing (no conflict)');
            return { conflict: false, reason: 'local_older' };
          }
        }

        // Local file is newer OR no timestamp provided - treat as conflict
        logger.warn({ localPath, localHash, cloudHash }, 'Conflict detected: content differs');
        return { conflict: true, reason: 'content_differs', localHash, cloudHash };

      } catch (err) {
        // Hash lengths differ, definitely a conflict
        logger.warn({ localPath, localHash, cloudHash, error: err.message }, 'Conflict detected: hash length differs');
        return { conflict: true, reason: 'hash_length_differs', localHash, cloudHash };
      }

    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist locally, no conflict (new file from cloud)
        logger.debug({ localPath }, 'Local file missing, no conflict (new from cloud)');
        return { conflict: false, reason: 'local_missing' };
      }

      // Unexpected error, re-throw
      logger.error({ localPath, error }, 'Unexpected error during conflict detection');
      throw error;
    }
  }
}
