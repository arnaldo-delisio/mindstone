import writeFileAtomic from 'write-file-atomic';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';
import { config } from './config.js';

/**
 * Progressive fallback poller with self-healing.
 *
 * When Realtime connection fails, this class:
 * - Polls Supabase every 30 seconds for updated files
 * - Processes polled files through downloader (reuses download + conflict detection logic)
 * - Persists lastPollTime to survive daemon restarts
 * - Uses 5-minute lookback window to catch files updated during daemon downtime
 * - Attempts Realtime reconnection every 5 minutes
 * - Stops polling when Realtime reconnects successfully
 *
 * Integration with conflict detection:
 * - Polled files flow through downloader.downloadFile() (from Plan 02-01)
 * - Downloader has conflict detection integrated (from Plan 02-02)
 * - Ensures polled files get same conflict detection as Realtime events
 * - Prevents overwriting local changes during polling mode
 */
export class FallbackPoller {
  // Lookback window duration (5 minutes in milliseconds)
  // This catches files updated during daemon restarts/downtime
  static LOOKBACK_WINDOW_MS = 5 * 60 * 1000;
  constructor(supabase, downloader, healthMonitor, fallbackStatePath) {
    this.supabase = supabase;
    this.downloader = downloader;
    this.healthMonitor = healthMonitor;
    this.fallbackStatePath = fallbackStatePath;
    this.pollInterval = null;
    this.reconnectInterval = null;
    this.isPolling = false;
    this.lastPollTime = null;
    this.realtimeSubscription = null;
  }

  /**
   * Start polling mode.
   * Called when Realtime connection fails after 3 attempts.
   *
   * @param {RealtimeSubscription} realtimeSubscription - Realtime subscription to attempt reconnection
   */
  async startPolling(realtimeSubscription) {
    if (this.isPolling) {
      logger.warn('Polling already active, ignoring startPolling call');
      return;
    }

    this.isPolling = true;
    this.realtimeSubscription = realtimeSubscription;

    logger.warn('Fallback polling started (Realtime connection failed)');

    // Load state from disk (lastPollTime survives daemon restart)
    await this.loadState();

    // Poll immediately on start
    await this.poll();

    // Poll every 30 seconds (120 queries/hour, safe for free tier)
    this.pollInterval = setInterval(async () => {
      await this.poll();
    }, 30000);

    // Attempt Realtime reconnection every 5 minutes
    this.reconnectInterval = setInterval(async () => {
      await this.attemptReconnect();
    }, 300000); // 5 minutes

    logger.info({ pollInterval: 30000, reconnectInterval: 300000 }, 'Fallback intervals configured');
  }

  /**
   * Perform initial sync on daemon startup.
   * Downloads all files without requiring polling mode to be active.
   * Used to catch files added while daemon was offline.
   *
   * @param {Set<string>} recentlySyncedFiles - Set to populate with synced file paths (optional)
   */
  async initialSync(recentlySyncedFiles) {
    logger.info('Starting initial sync');

    try {
      // Load state to get lastPollTime
      await this.loadState();

      // Fetch all files (or files updated since last sync)
      await this._performPoll(recentlySyncedFiles);

      logger.info('Initial sync completed successfully');
    } catch (error) {
      logger.error({ error: error.message }, 'Initial sync failed');
      throw error;
    }
  }

  /**
   * Poll Supabase for files updated since last poll.
   * Processes polled files through downloader for conflict detection.
   */
  async poll() {
    if (!this.isPolling) {
      logger.debug('Polling stopped, skipping poll');
      return;
    }

    await this._performPoll();
  }

  /**
   * Internal method that performs the actual polling logic.
   * Shared by both initialSync() and poll().
   *
   * @param {Set<string>} recentlySyncedFiles - Set to populate with synced file paths (optional)
   */
  async _performPoll(recentlySyncedFiles) {
    try {
      logger.debug({ lastPollTime: this.lastPollTime }, 'Starting poll');

      // Capture query start time BEFORE executing query
      // This prevents race condition where files created during query are lost
      const queryStartTime = new Date().toISOString();

      // Query files updated since last poll with lookback window
      // Lookback window catches files updated during daemon restarts
      // If lastPollTime is null (first poll), fetch all files for user
      let query = this.supabase
        .from('files')
        .select('*')
        .eq('user_id', config.supabase.userId);

      if (this.lastPollTime) {
        // Apply lookback window: subtract 5 minutes from lastPollTime
        // This catches files that were updated during daemon downtime
        const lookbackTime = new Date(new Date(this.lastPollTime).getTime() - FallbackPoller.LOOKBACK_WINDOW_MS);
        const lookbackTimeISO = lookbackTime.toISOString();

        query = query.gte('updated_at', lookbackTimeISO);

        logger.debug({
          lastPollTime: this.lastPollTime,
          lookbackTime: lookbackTimeISO,
          lookbackWindowMinutes: FallbackPoller.LOOKBACK_WINDOW_MS / (60 * 1000)
        }, 'Using lookback window for poll query');
      }

      const { data: files, error } = await query;

      if (error) {
        logger.error({ error: error.message }, 'Poll query failed');
        throw error;
      }

      logger.debug({ fileCount: files.length }, 'Poll completed');

      // Process each file through downloader
      // Downloader handles conflict detection (Plan 02-02 integration)
      for (const file of files) {
        try {
          await this.downloader.downloadFile(file);

          // Track synced file to prevent watcher race condition
          if (recentlySyncedFiles) {
            const localPath = join(config.vault.path, file.path);
            recentlySyncedFiles.add(localPath);
            logger.debug({ path: localPath }, 'Tracked file in initial sync');
          }
        } catch (error) {
          logger.error({ path: file.path, error: error.message }, 'Download failed during polling');
          // Continue processing other files
        }
      }

      // Update lastPollTime to query start time (not current time)
      // This ensures files created during query/processing are caught in next poll
      this.lastPollTime = queryStartTime;
      await this.saveState();

      // Update health metrics
      this.healthMonitor.recordPoll(files.length);

      logger.info({ filesProcessed: files.length, lastPollTime: this.lastPollTime }, 'Poll cycle completed');

    } catch (error) {
      logger.error({ error: error.message }, 'Poll failed');
      // Don't throw - keep polling on next interval
    }
  }

  /**
   * Attempt to reconnect to Realtime.
   * If successful, stop polling and return to Realtime mode.
   */
  async attemptReconnect() {
    if (!this.isPolling) {
      logger.debug('Polling stopped, skipping reconnect attempt');
      return;
    }

    logger.info('Attempting Realtime reconnection');
    this.healthMonitor.recordReconnectAttempt();

    try {
      // Attempt to resubscribe to Realtime
      await this.realtimeSubscription.subscribe();

      // Check subscription status
      const status = this.realtimeSubscription.getStatus();

      if (status === 'SUBSCRIBED') {
        logger.info('Realtime reconnection successful');

        // Stop polling and return to Realtime mode
        await this.stopPolling();

        // Update health metrics
        this.healthMonitor.recordReconnectSuccess();

        logger.warn('Fallback polling stopped (Realtime reconnected)');
      } else {
        logger.warn({ status }, 'Realtime reconnection attempt failed');
      }

    } catch (error) {
      logger.warn({ error: error.message }, 'Realtime reconnection attempt failed');
      // Continue polling on next interval
    }
  }

  /**
   * Stop polling mode.
   * Called when Realtime reconnects successfully or daemon shuts down.
   */
  async stopPolling() {
    if (!this.isPolling) {
      logger.debug('Polling already stopped');
      return;
    }

    this.isPolling = false;

    // Clear intervals
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    // Save final state
    await this.saveState();

    logger.info('Fallback polling stopped');
  }

  /**
   * Load polling state from disk.
   * Survives daemon restarts.
   */
  async loadState() {
    try {
      const stateJson = await readFile(this.fallbackStatePath, 'utf-8');
      const state = JSON.parse(stateJson);

      this.lastPollTime = state.lastPollTime || null;

      logger.debug({ lastPollTime: this.lastPollTime }, 'Fallback state loaded');
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, first run
        logger.debug('Fallback state file not found, initializing');
        this.lastPollTime = null;
      } else {
        logger.error({ error: error.message }, 'Failed to load fallback state');
        // Continue with null lastPollTime
        this.lastPollTime = null;
      }
    }
  }

  /**
   * Save polling state to disk.
   * Uses atomic write to prevent corruption on daemon crash.
   */
  async saveState() {
    try {
      const state = {
        lastPollTime: this.lastPollTime
      };

      await writeFileAtomic(
        this.fallbackStatePath,
        JSON.stringify(state, null, 2)
      );

      logger.debug({ lastPollTime: this.lastPollTime }, 'Fallback state saved');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to save fallback state');
      // Non-fatal, continue
    }
  }
}
