import writeFileAtomic from 'write-file-atomic';
import { unlink } from 'node:fs/promises';
import { glob } from 'glob';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Resolves conflicts by creating side-by-side conflict files and auto-deleting
 * them when the user merges changes into the main file.
 */
export class ConflictResolver {
  /**
   * Resolve a conflict by saving the cloud version to a .conflict-{timestamp}.md file.
   * Local file remains unchanged (user's current view is primary).
   *
   * @param {string} localPath - Absolute path to local file
   * @param {string} cloudContent - Full content from cloud (frontmatter + body)
   * @param {string} cloudHash - SHA-256 hash from cloud (for logging)
   * @returns {Promise<Object>} Resolution result with conflictPath
   */
  async resolveConflict(localPath, cloudContent, cloudHash) {
    // Generate conflict filename with Unix timestamp (sortable, filename-safe)
    const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
    const conflictPath = this.getConflictPath(localPath, timestamp);

    logger.warn(
      { localPath, conflictPath, cloudHash, timestamp },
      'Conflict detected, saving cloud version to conflict file'
    );

    // Write cloud version to conflict file atomically (crash-safe)
    await writeFileAtomic(conflictPath, cloudContent);

    logger.info({ conflictPath }, 'Conflict file created');

    // Local file remains unchanged - user will manually review and merge
    // When user saves main file, watcher triggers autoDeleteConflictFiles()
    return { conflictPath, localPreserved: true };
  }

  /**
   * Generate conflict file path for an original file.
   *
   * @param {string} originalPath - Absolute path to original file
   * @param {number} timestamp - Unix timestamp in seconds
   * @returns {string} Conflict file path
   * @example
   *   getConflictPath('/path/to/vault/learning.md', 1737389123)
   *   // => '/path/to/vault/learning.conflict-1737389123.md'
   */
  getConflictPath(originalPath, timestamp) {
    const parsed = path.parse(originalPath);
    return path.join(
      parsed.dir,
      `${parsed.name}.conflict-${timestamp}${parsed.ext}`
    );
  }

  /**
   * Auto-delete all conflict files associated with a main file.
   * Called when user edits the main file (assumes user has merged changes).
   *
   * @param {string} mainFilePath - Absolute path to main file
   * @returns {Promise<void>}
   */
  async autoDeleteConflictFiles(mainFilePath) {
    const pattern = this.getConflictPattern(mainFilePath);

    try {
      const conflictFiles = await glob(pattern);

      if (conflictFiles.length === 0) {
        logger.debug({ mainFilePath }, 'No conflict files to delete');
        return;
      }

      for (const conflictFile of conflictFiles) {
        try {
          await unlink(conflictFile);
          logger.info(
            { conflictFile, mainFile: mainFilePath },
            'Auto-deleted conflict file after main file edit'
          );
        } catch (error) {
          if (error.code === 'ENOENT') {
            // File already deleted, ignore
            logger.debug({ conflictFile }, 'Conflict file already deleted');
          } else {
            // Log error but continue with other deletions
            logger.error({ conflictFile, error }, 'Error deleting conflict file');
          }
        }
      }
    } catch (error) {
      logger.error({ mainFilePath, pattern, error }, 'Error finding conflict files');
    }
  }

  /**
   * Generate glob pattern to find all conflict files for a main file.
   *
   * @param {string} mainFilePath - Absolute path to main file
   * @returns {string} Glob pattern
   * @example
   *   getConflictPattern('/path/to/vault/learning.md')
   *   // => '/path/to/vault/learning.conflict-*.md'
   */
  getConflictPattern(mainFilePath) {
    const parsed = path.parse(mainFilePath);
    return path.join(parsed.dir, `${parsed.name}.conflict-*${parsed.ext}`);
  }
}
