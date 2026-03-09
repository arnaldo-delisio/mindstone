import writeFileAtomic from 'write-file-atomic';
import { logger } from './logger.js';

export class HealthMonitor {
  constructor(healthPath) {
    this.healthPath = healthPath;
    this.metrics = {
      daemon_started_at: new Date().toISOString(),
      last_health_check: null,
      watcher_status: 'stopped',
      files_watched: 0,
      sync_operations: {
        total_synced: 0,
        total_skipped: 0,
        last_sync_at: null,
        pending_queue_size: 0,
        failed_operations: 0
      },
      errors: {
        last_error_at: null,
        last_error_message: null,
        total_errors: 0
      },
      fallback: {
        fallback_mode: false,
        last_realtime_failure: null,
        fallback_started: null,
        last_poll_time: null,
        reconnect_attempts: 0
      }
    };
    this.periodicInterval = null;
  }

  async update(updates) {
    Object.assign(this.metrics, updates);
    this.metrics.last_health_check = new Date().toISOString();

    await writeFileAtomic(
      this.healthPath,
      JSON.stringify(this.metrics, null, 2)
    );
  }

  recordSync(filePath, result) {
    if (result.synced) {
      this.metrics.sync_operations.total_synced++;
      this.metrics.sync_operations.last_sync_at = new Date().toISOString();
    } else if (result.skipped) {
      this.metrics.sync_operations.total_skipped++;
    }

    logger.debug({ filePath, result }, 'Sync recorded in health metrics');
  }

  recordError(error) {
    this.metrics.errors.total_errors++;
    this.metrics.errors.last_error_at = new Date().toISOString();
    this.metrics.errors.last_error_message = error.message;
  }

  updateQueueMetrics(retryQueue) {
    this.metrics.sync_operations.pending_queue_size = retryQueue.getSize();
    this.metrics.sync_operations.failed_operations = retryQueue.getFailedCount();
  }

  async startPeriodicWrite() {
    // Write health metrics every 30 seconds (REL-05)
    this.periodicInterval = setInterval(async () => {
      try {
        await this.update({});
        logger.debug('Health metrics written');
      } catch (error) {
        logger.error({ error }, 'Failed to write health metrics');
      }
    }, 30000); // 30 seconds

    logger.info({ interval: 30000 }, 'Periodic health monitoring started');
  }

  stopPeriodicWrite() {
    if (this.periodicInterval) {
      clearInterval(this.periodicInterval);
      this.periodicInterval = null;
      logger.info('Periodic health monitoring stopped');
    }
  }

  // Get current metrics for logging
  getMetrics() {
    return { ...this.metrics };
  }

  // Fallback mode tracking methods

  setFallbackMode(enabled, reason) {
    this.metrics.fallback.fallback_mode = enabled;

    if (enabled) {
      this.metrics.fallback.last_realtime_failure = new Date().toISOString();
      this.metrics.fallback.fallback_started = new Date().toISOString();
      this.metrics.fallback.reconnect_attempts = 0;
      logger.warn({ reason }, 'Fallback mode enabled');
    } else {
      this.metrics.fallback.last_realtime_failure = null;
      this.metrics.fallback.fallback_started = null;
      logger.info('Fallback mode disabled');
    }
  }

  recordPoll(filesCount) {
    this.metrics.fallback.last_poll_time = new Date().toISOString();
    this.metrics.sync_operations.last_sync_at = new Date().toISOString();
    logger.debug({ filesCount, lastPollTime: this.metrics.fallback.last_poll_time }, 'Poll recorded in health metrics');
  }

  recordReconnectAttempt() {
    this.metrics.fallback.reconnect_attempts++;
    logger.debug({ attempts: this.metrics.fallback.reconnect_attempts }, 'Reconnect attempt recorded');
  }

  recordReconnectSuccess() {
    this.metrics.fallback.fallback_mode = false;
    this.metrics.fallback.last_realtime_failure = null;
    this.metrics.fallback.fallback_started = null;
    this.metrics.fallback.reconnect_attempts = 0;
    logger.info('Realtime reconnection successful, fallback metrics reset');
  }
}
