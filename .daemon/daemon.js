#!/usr/bin/env node

import { createWatcher } from './src/watcher.js';
import { syncFile } from './src/syncer.js';
import { RetryQueue } from './src/retry-queue.js';
import { HealthMonitor } from './src/health.js';
import { SessionAnalyzer } from './src/session-analyzer.js';
import { RealtimeSubscription } from './src/realtime.js';
import { Downloader } from './src/downloader.js';
import { FallbackPoller } from './src/fallback-poller.js';
import { Reconciliation } from './src/reconciliation.js';
import { logger } from './src/logger.js';
import { config } from './src/config.js';
import { supabase } from './src/supabase-client.js';
import { deleteGcalEvent, isGcalEnabled } from '../.intelligence/dist/services/gcal.js';
import { join, relative } from 'node:path';
import { mkdir, stat, unlink } from 'node:fs/promises';
import * as systemdNotify from './src/systemd-notify.js';

let watcher = null;
let isShuttingDown = false;
let retryQueue = null;
let health = null;
let sessionAnalyzer = null;
let watchdogInterval = null;
let realtimeSubscription = null;
let downloader = null;
let fallbackPoller = null;
let reconciliation = null;
let recentlyDeleted = new Set();

/**
 * Handle Realtime events from cloud.
 * Processes INSERT, UPDATE, DELETE events through p-queue for rate limiting.
 */
async function handleRealtimeEvent(payload) {
  const { eventType, new: newRecord, old: oldRecord } = payload;

  if (eventType === 'INSERT' || eventType === 'UPDATE') {
    // Add download to queue (rate-limited through retryQueue's p-queue)
    await retryQueue.queue.add(async () => {
      try {
        await downloader.downloadFile(newRecord);
        sessionAnalyzer?.trackOperation('cloud_download', newRecord.path, {
          eventType,
          cloudHash: newRecord.content_hash
        });
      } catch (error) {
        logger.error({ path: newRecord.path, error: error.message }, 'Download failed');
        sessionAnalyzer?.trackOperation('download_failed', newRecord.path, {
          error: error.message
        });
      }
    });
  }

  if (eventType === 'DELETE') {
    const path = oldRecord?.path;
    // Guard: if path is missing, old record was empty (REPLICA IDENTITY not FULL) — cannot proceed
    if (!path) {
      logger.warn({ oldRecord }, 'DELETE event received but oldRecord.path is missing — check REPLICA IDENTITY FULL on files table');
      return;
    }
    // Echo check: if this DELETE was triggered by our own onUnlink, skip
    if (recentlyDeleted.has(path)) {
      logger.debug({ path }, 'DELETE echo detected (local deletion triggered this), skipping');
      return;
    }
    // Supabase record deleted externally (MCP tool, gcal-poller) → delete local file
    const localPath = join(config.vault.path, path);
    try {
      await unlink(localPath);
      logger.info({ path, localPath }, 'Supabase DELETE → local file removed');
      sessionAnalyzer?.trackOperation('cloud_delete', path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.debug({ path }, 'Local file already gone, nothing to delete');
      } else {
        logger.error({ path, err: err.message }, 'Failed to delete local file after Supabase DELETE');
      }
    }
  }
}

async function start() {
  logger.info('Starting vault sync daemon');

  // Ensure .sync directory exists
  try {
    await mkdir(config.vault.syncDir, { recursive: true });
  } catch (error) {
    logger.error({ error }, 'Failed to create .sync directory');
    throw error;
  }

  // Initialize retry queue
  retryQueue = new RetryQueue(config.vault.queuePath, syncFile);
  await retryQueue.load();
  await retryQueue.processAll(); // Process operations from previous session (REL-04)

  // Initialize health monitoring
  health = new HealthMonitor(config.vault.healthPath);
  await health.update({ watcher_status: 'starting' });
  await health.startPeriodicWrite(); // Write every 30 seconds (REL-05)

  // Initialize session analysis
  const sessionLogPath = join(config.vault.syncDir, `session-${Date.now()}.json`);
  sessionAnalyzer = new SessionAnalyzer(sessionLogPath);

  // Track files synced during initial sync to prevent watcher race condition
  // Prevents local files from overwriting fresh intelligence updates in Supabase
  const recentlySyncedFiles = new Set();

  // Start file watcher
  watcher = createWatcher({
    recentlySyncedFiles,
    onAdd: async (path) => {
      sessionAnalyzer.trackOperation('file_created', path);
      await handleFileSync(path, 'add');
    },
    onChange: async (path) => {
      sessionAnalyzer.trackOperation('file_changed', path);
      await handleFileSync(path, 'change');
    },
    onUnlink: async (path) => {
      sessionAnalyzer.trackOperation('file_deleted', path);
      const relativePath = relative(config.vault.path, path);
      // Track for echo prevention before issuing Supabase DELETE
      recentlyDeleted.add(relativePath);
      setTimeout(() => recentlyDeleted.delete(relativePath), 30000);
      try {
        // Read gcal_event_id from Supabase before deleting the row (file is already gone)
        const { data: fileRow } = await supabase
          .from('files')
          .select('gcal_event_id, gcal_calendar')
          .eq('path', relativePath)
          .eq('user_id', config.supabase.userId)
          .single();

        const { error } = await supabase
          .from('files')
          .delete()
          .eq('path', relativePath)
          .eq('user_id', config.supabase.userId);
        if (error) {
          logger.error({ path: relativePath, err: error.message }, 'Failed to delete file from Supabase');
        } else {
          logger.info({ path: relativePath }, 'Local delete → Supabase record removed');
        }

        // Delete from GCal if this was a synced event
        if (fileRow?.gcal_event_id && isGcalEnabled()) {
          await deleteGcalEvent(fileRow.gcal_event_id, fileRow.gcal_calendar ?? undefined);
          logger.info({ gcal_event_id: fileRow.gcal_event_id }, 'Local delete → GCal event deleted');
        }
      } catch (err) {
        logger.error({ path: relativePath, err: err.message }, 'Unexpected error deleting from Supabase');
      }
    },
    onError: (error) => {
      health.recordError(error);
    }
  });

  await health.update({ watcher_status: 'running' });

  // Initialize downloader (Phase 2)
  downloader = new Downloader(retryQueue.queue);
  logger.info('Downloader initialized');

  // Initialize fallback poller (Phase 2 - Plan 02-03)
  const fallbackStatePath = join(config.vault.syncDir, 'fallback-state.json');
  fallbackPoller = new FallbackPoller(supabase, downloader, health, fallbackStatePath);
  logger.info('Fallback poller initialized');

  // Perform initial sync on startup to catch files added while daemon was offline
  // This ensures no gap between daemon restarts - files added during downtime are synced
  // Track synced files to prevent watcher from immediately re-uploading them
  logger.info('Performing initial sync to catch up on changes during downtime');
  try {
    await fallbackPoller.initialSync(recentlySyncedFiles);
    logger.info({ trackedFiles: recentlySyncedFiles.size }, 'Initial sync tracked files');
    await health.update({ initial_sync: 'completed' });
  } catch (error) {
    logger.error({ error: error.message }, 'Initial sync failed, continuing with Realtime');
    await health.update({ initial_sync: 'failed' });
    // Non-fatal, continue to Realtime subscription
  }

  // Initialize Realtime subscription (Phase 2)
  realtimeSubscription = new RealtimeSubscription(
    supabase,
    handleRealtimeEvent,
    (error) => {
      logger.error({ error: error.message }, 'Realtime subscription error handler invoked');
      health.recordError(error);

      // Start fallback polling (Plan 02-03)
      if (!fallbackPoller.isPolling) {
        health.setFallbackMode(true, error.message);
        fallbackPoller.startPolling(realtimeSubscription);
        logger.warn('Fallback polling started due to Realtime error');
      }
    },
    async () => {
      // Success callback: Realtime recovered from failure state
      // Stop fallback polling immediately instead of waiting 5 minutes
      if (fallbackPoller.isPolling) {
        logger.info('Realtime reconnected successfully, stopping fallback polling');
        await fallbackPoller.stopPolling();
        health.recordReconnectSuccess();
        logger.info('Fallback mode disabled, Realtime mode restored');
      }
    }
  );

  try {
    await realtimeSubscription.subscribe();
    logger.info('Realtime subscription active');
    await health.update({ realtime_status: 'active' });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to initialize Realtime subscription');
    await health.update({ realtime_status: 'failed' });
    // Continue without Realtime (fallback to be implemented in 02-03)
  }

  // Initialize and start periodic reconciliation
  reconciliation = new Reconciliation(downloader, health);
  reconciliation.start(config.reconciliation.interval);
  logger.info({
    intervalMs: config.reconciliation.interval,
    intervalHours: config.reconciliation.interval / (1000 * 60 * 60)
  }, 'Periodic reconciliation started');

  logger.info('Daemon started successfully');

  // Signal systemd that daemon is ready (Type=notify)
  try {
    await systemdNotify.ready();
    logger.debug('Sent ready notification to systemd');
  } catch (err) {
    logger.warn({ err }, 'Failed to send ready notification (systemd not available)');
  }

  // Start watchdog keepalive pings if running under systemd
  // WatchdogSec=30 in service file, so ping every 15 seconds (half interval for safety)
  if (process.env.NOTIFY_SOCKET) {
    const watchdogMs = 30000; // 30 seconds to match WatchdogSec=30
    const pingIntervalMs = 15000; // Ping at half interval for safety margin

    watchdogInterval = setInterval(async () => {
      try {
        await systemdNotify.watchdog();
        logger.debug({ watchdogMs, pingIntervalMs }, 'Sent watchdog ping');
      } catch (err) {
        logger.warn({ err }, 'Failed to send watchdog ping');
      }
    }, pingIntervalMs);

    logger.info({ watchdogMs, pingIntervalMs }, 'Watchdog keepalive started');
  }
}

async function handleFileSync(filePath, eventType) {
  try {
    // Timestamp guard: Check if cloud version is newer before uploading
    // Prevents overwriting intelligence updates or other cloud changes
    const relativePath = relative(config.vault.path, filePath);
    const localStats = await stat(filePath);

    const { data: cloudRecord, error: cloudError } = await supabase
      .from('files')
      .select('updated_at, content_hash')
      .eq('user_id', config.supabase.userId)
      .eq('path', relativePath)
      .single();

    // If cloud record exists and is newer than local file, download instead
    if (cloudRecord && !cloudError) {
      const cloudUpdatedAt = new Date(cloudRecord.updated_at);
      const localModifiedAt = localStats.mtime;

      if (cloudUpdatedAt > localModifiedAt) {
        logger.info({
          path: relativePath,
          cloudTime: cloudUpdatedAt.toISOString(),
          localTime: localModifiedAt.toISOString()
        }, 'Cloud version newer than local, downloading instead of uploading');

        sessionAnalyzer.trackOperation('download_instead_of_upload', filePath, {
          cloudTime: cloudUpdatedAt,
          localTime: localModifiedAt
        });

        // Download the newer cloud version
        try {
          const fullCloudRecord = await supabase
            .from('files')
            .select('*')
            .eq('user_id', config.supabase.userId)
            .eq('path', relativePath)
            .single();

          if (fullCloudRecord.data) {
            await downloader.downloadFile(fullCloudRecord.data);
            logger.info({ path: relativePath }, 'Downloaded newer cloud version');
          }
        } catch (error) {
          logger.error({ path: relativePath, error: error.message }, 'Failed to download cloud version');
        }

        return;
      }
    }

    // Proceed with upload - local is newer or file doesn't exist in cloud
    const result = await syncFile(filePath);

    // Record in health and session
    health.recordSync(filePath, result);

    if (result.synced) {
      sessionAnalyzer.trackOperation('sync_completed', filePath, {
        contentHash: result.contentHash
      });
      logger.info({ filePath, eventType }, 'File synced successfully');
    } else if (result.skipped) {
      sessionAnalyzer.trackOperation('sync_skipped', filePath, {
        reason: result.reason
      });
      logger.warn({ filePath, reason: result.reason }, 'File sync skipped');
    }

    // Update queue metrics in health
    health.updateQueueMetrics(retryQueue);

  } catch (error) {
    // Sync failed - add to retry queue (REL-02)
    logger.error({ filePath, error: error.message }, 'Sync failed, adding to retry queue');

    sessionAnalyzer.trackOperation('sync_failed', filePath, {
      error: error.message
    });

    await retryQueue.add({
      type: 'sync_file',
      path: filePath,
      eventType,
      error: error.message
    });

    health.recordError(error);
    health.updateQueueMetrics(retryQueue);
  }
}

// Graceful shutdown handler
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received');

  try {
    // Stop periodic reconciliation
    if (reconciliation) {
      reconciliation.stop();
      logger.info('Periodic reconciliation stopped');
    }

    // Stop fallback polling if active (Phase 2 - Plan 02-03)
    if (fallbackPoller && fallbackPoller.isPolling) {
      await fallbackPoller.stopPolling();
      logger.info('Fallback polling stopped');
    }

    // Stop Realtime subscription (Phase 2)
    if (realtimeSubscription) {
      await realtimeSubscription.unsubscribe();
      logger.info('Realtime subscription removed');
    }

    // Stop accepting new file events
    if (watcher) {
      await watcher.close();
      logger.info('Watcher closed');
    }

    // Stop watchdog pings
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      logger.info('Watchdog keepalive stopped');
    }

    // Signal systemd we're shutting down gracefully
    try {
      await systemdNotify.stopping();
      logger.debug('Sent stopping notification to systemd');
    } catch (err) {
      logger.warn({ err }, 'Failed to send stopping notification');
    }

    // Save retry queue (REL-04)
    if (retryQueue) {
      await retryQueue.save();
      logger.info('Retry queue saved');
    }

    // Stop health monitoring
    if (health) {
      health.stopPeriodicWrite();
      await health.update({ watcher_status: 'stopped' });
      logger.info('Health monitoring stopped');
    }

    // Write session analysis
    if (sessionAnalyzer) {
      await sessionAnalyzer.writeSession();
      logger.info('Session analysis written');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  logger.error({ error }, 'Unhandled rejection');
  if (health) health.recordError(error);
});

// Start daemon
start().catch(error => {
  logger.error({ error }, 'Failed to start daemon');
  process.exit(1);
});
