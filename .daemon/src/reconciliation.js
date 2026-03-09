import { join } from 'node:path';
import { access, constants, unlink, readdir } from 'node:fs/promises';
import { logger } from './logger.js';
import { config } from './config.js';
import { supabase } from './supabase-client.js';

/**
 * Periodic reconciliation to catch orphaned files that weren't synced down.
 * Runs on a configurable interval to ensure local vault matches cloud state.
 *
 * This catches files that were missed due to:
 * - Daemon downtime during cloud updates
 * - Network errors during sync
 * - Realtime subscription failures
 * - Missing local directories during initial sync attempts
 */
export class Reconciliation {
  constructor(downloader, healthMonitor) {
    this.downloader = downloader;
    this.health = healthMonitor;
    this.isReconciling = false;
    this.lastReconciliation = null;
    this.reconciliationInterval = null;
  }

  /**
   * Start periodic reconciliation timer
   */
  start(intervalMs) {
    if (this.reconciliationInterval) {
      logger.warn('Reconciliation already started');
      return;
    }

    logger.info({ intervalMs, intervalHours: intervalMs / (1000 * 60 * 60) }, 'Starting periodic reconciliation');

    // Run first reconciliation after 5 minutes (give daemon time to stabilize)
    setTimeout(() => this.runReconciliation(), 5 * 60 * 1000);

    // Then run on regular interval
    this.reconciliationInterval = setInterval(() => {
      this.runReconciliation();
    }, intervalMs);
  }

  /**
   * Stop periodic reconciliation
   */
  stop() {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
      logger.info('Periodic reconciliation stopped');
    }
  }

  /**
   * Run a single reconciliation cycle
   */
  async runReconciliation() {
    if (this.isReconciling) {
      logger.warn('Reconciliation already in progress, skipping');
      return;
    }

    this.isReconciling = true;
    const startTime = Date.now();

    try {
      logger.info('Starting reconciliation cycle');
      await this.health?.update({ reconciliation_status: 'running' });

      // Fetch all files from cloud
      const { data: cloudFiles, error } = await supabase
        .from('files')
        .select('*')
        .eq('user_id', config.supabase.userId);

      if (error) {
        throw new Error(`Failed to fetch cloud files: ${error.message}`);
      }

      logger.info({ totalCloudFiles: cloudFiles.length }, 'Fetched cloud files');

      // Check which files are missing locally (only .md files)
      const missingFiles = [];
      for (const file of cloudFiles) {
        // Skip non-.md files — they shouldn't be downloaded locally
        if (!file.path.endsWith('.md')) continue;

        const localPath = join(config.vault.path, file.path);

        try {
          await access(localPath, constants.F_OK);
          // File exists locally, skip
        } catch {
          // File doesn't exist locally, needs download
          missingFiles.push(file);
        }
      }

      // Orphan cleanup: delete local event files no longer in Supabase.
      // Scoped to all events/*.md — all event files are cloud-originated (created via
      // manage_event MCP tool which writes to Supabase first). Supabase Realtime DELETE
      // events don't include oldRecord.path when a filter is active, so reconciliation
      // is the reliable fallback for cleaning up cancelled/deleted events.
      const cloudPaths = new Set(cloudFiles.map(f => f.path));
      const eventsDir = join(config.vault.path, 'events');
      let orphanCount = 0;
      try {
        const eventFiles = await readdir(eventsDir);
        for (const filename of eventFiles) {
          if (!filename.endsWith('.md')) continue;
          const relativePath = `events/${filename}`;
          if (!cloudPaths.has(relativePath)) {
            await unlink(join(eventsDir, filename));
            orphanCount++;
            logger.info({ path: relativePath }, 'Reconciliation: orphaned event file deleted');
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error({ err: err.message }, 'Reconciliation: failed to scan events dir for orphans');
        }
      }

      if (missingFiles.length === 0) {
        logger.info({ orphanCount }, 'Reconciliation complete: no missing files');
        await this.health?.update({
          reconciliation_status: 'idle',
          last_reconciliation: new Date().toISOString(),
          last_reconciliation_synced: 0
        });
        this.lastReconciliation = {
          timestamp: new Date(),
          synced: 0,
          orphansDeleted: orphanCount,
          duration: Date.now() - startTime
        };
        return;
      }

      logger.info({ missingCount: missingFiles.length }, 'Found missing files, downloading');

      // Download missing files using existing downloader
      let syncedCount = 0;
      const errors = [];

      for (const file of missingFiles) {
        try {
          await this.downloader.downloadFile(file);
          syncedCount++;
          logger.info({ path: file.path }, 'Reconciliation synced file');
        } catch (error) {
          errors.push({ path: file.path, error: error.message });
          logger.error({ path: file.path, error: error.message }, 'Reconciliation download failed');
        }
      }

      const duration = Date.now() - startTime;
      logger.info({
        synced: syncedCount,
        failed: errors.length,
        total: missingFiles.length,
        orphansDeleted: orphanCount,
        durationMs: duration
      }, 'Reconciliation cycle completed');

      await this.health?.update({
        reconciliation_status: 'idle',
        last_reconciliation: new Date().toISOString(),
        last_reconciliation_synced: syncedCount,
        last_reconciliation_failed: errors.length
      });

      this.lastReconciliation = {
        timestamp: new Date(),
        synced: syncedCount,
        failed: errors.length,
        orphansDeleted: orphanCount,
        duration,
        errors: errors.slice(0, 10) // Keep last 10 errors
      };

    } catch (error) {
      logger.error({ error: error.message }, 'Reconciliation cycle failed');
      await this.health?.update({
        reconciliation_status: 'error',
        reconciliation_error: error.message
      });
      this.health?.recordError(error);
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Get last reconciliation stats
   */
  getStats() {
    return this.lastReconciliation;
  }
}
