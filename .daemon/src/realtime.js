import { logger } from './logger.js';
import { config } from './config.js';

/**
 * Manages Supabase Realtime subscription lifecycle for postgres_changes events.
 * Handles connection states, automatic reconnection via Supabase client, and
 * progressive fallback trigger after persistent failures.
 */
export class RealtimeSubscription {
  constructor(supabase, onUpdate, onError, onReconnectSuccess = null) {
    this.supabase = supabase;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onReconnectSuccess = onReconnectSuccess; // Callback when Realtime recovers from error state
    this.channel = null;
    this.isSubscribed = false;
    this.failureCount = 0;
    this.status = 'UNSUBSCRIBED';
    this.stabilityTimer = null; // Timer to verify connection is stable before resetting failure count
    this.recentEvents = new Map(); // Deduplication: track recent events by path+hash
    this.maxCacheSize = 500; // LRU limit for deduplication cache
    this.wasInFailureState = false; // Track if we were in error/timeout/closed state
  }

  /**
   * Subscribe to postgres_changes for files table filtered by user_id.
   * Uses RLS-optimized filter syntax for minimal payload size.
   */
  async subscribe() {
    try {
      // CRITICAL: Clean up existing channel before creating new one
      // Prevents multiple subscriptions from accumulating and sending duplicate events
      if (this.channel) {
        logger.info('Cleaning up existing channel before resubscribing');
        await this.supabase.removeChannel(this.channel);
        this.channel = null;
        this.isSubscribed = false;
      }

      // Use fixed user ID from config (single-user system with service role key)
      const userId = config.supabase.userId;

      logger.info({ userId }, 'Initializing Realtime subscription');

      // Create channel and subscribe to postgres_changes
      this.channel = this.supabase
        .channel('files-changes')
        .on(
          'postgres_changes',
          {
            event: '*', // Listen to INSERT, UPDATE, DELETE
            schema: 'public',
            table: 'files',
            filter: `user_id=eq.${userId}` // RLS-optimized syntax
          },
          (payload) => this.handleChange(payload)
        )
        .subscribe((status, err) => this.handleStatus(status, err));

      logger.info('Realtime subscription initiated');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize subscription');
      throw error;
    }
  }

  /**
   * Handle subscription status changes.
   * Tracks failures for progressive fallback trigger.
   * Supabase client handles automatic reconnection (1s, 2s, 5s, 10s backoff).
   *
   * IMPORTANT: failureCount only resets after connection proves stable (30 seconds).
   * This prevents rapid reconnect/timeout cycles from preventing fallback activation.
   */
  handleStatus(status, err) {
    this.status = status;
    logger.info({ status, error: err?.message }, 'Subscription status change');

    if (status === 'SUBSCRIBED') {
      this.isSubscribed = true;
      logger.info({ currentFailureCount: this.failureCount }, 'Realtime subscription active');

      // If we were in a failure state and now successfully reconnected, notify daemon
      // This allows fallback polling to stop immediately instead of waiting 5 minutes
      if (this.wasInFailureState && this.failureCount > 0 && this.onReconnectSuccess) {
        logger.info('Realtime recovered from failure state, notifying daemon');
        this.onReconnectSuccess();
      }
      this.wasInFailureState = false;

      // Don't reset failureCount immediately on reconnection
      // Wait 30 seconds to ensure connection is stable before trusting it
      // This prevents rapid reconnect/timeout cycles from preventing fallback
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
      }

      this.stabilityTimer = setTimeout(() => {
        const previousCount = this.failureCount;
        this.failureCount = 0;
        logger.info(
          { previousFailureCount: previousCount },
          'Realtime connection stable for 30s, failure count reset'
        );
      }, 30000); // 30 seconds
    }

    if (status === 'CHANNEL_ERROR') {
      this.isSubscribed = false;
      this.wasInFailureState = true;

      // Cancel stability timer - connection wasn't stable
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }

      this.failureCount++;

      // Enhanced error logging to capture full error context when message is undefined
      const errorInfo = {
        message: err?.message,
        code: err?.code,
        type: err?.type,
        fullError: err ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : 'undefined'
      };

      logger.error(
        { error: errorInfo, failureCount: this.failureCount },
        'Subscription channel error'
      );

      // Trigger fallback after 2 failures (faster recovery)
      if (this.failureCount >= 2) {
        logger.warn('Realtime failures threshold reached (2), triggering fallback');
        this.onError(new Error(`Channel error after ${this.failureCount} failures: ${err?.message || 'unknown error'}`));
      }
    }

    if (status === 'TIMED_OUT') {
      this.isSubscribed = false;
      this.wasInFailureState = true;

      // Cancel stability timer - connection wasn't stable
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }

      this.failureCount++;
      logger.warn(
        { failureCount: this.failureCount },
        'Subscription timed out'
      );

      // Trigger fallback after 2 timeouts (faster recovery in unstable networks like WSL2)
      // Reduced from 3 to 2 to minimize sync delay when Realtime is unreliable
      if (this.failureCount >= 2) {
        logger.warn('Realtime timeout threshold reached (2), triggering fallback');
        this.onError(new Error(`Timeout after ${this.failureCount} attempts`));
      } else {
        // Manual reconnection attempt (Supabase client auto-reconnect isn't working reliably in WSL2)
        logger.info({ failureCount: this.failureCount }, 'Manually triggering reconnection attempt');

        // Unsubscribe and resubscribe to force reconnection
        setTimeout(async () => {
          try {
            if (this.channel) {
              logger.debug('Removing timed-out channel');
              await this.supabase.removeChannel(this.channel);
            }

            logger.info('Re-establishing Realtime subscription after timeout');
            await this.subscribe();
          } catch (error) {
            logger.error({ error: error.message }, 'Manual reconnection failed');
            // Let next timeout cycle try again
          }
        }, 2000); // Wait 2 seconds before reconnecting
      }
    }

    if (status === 'CLOSED') {
      this.isSubscribed = false;
      this.wasInFailureState = true;

      // Cancel stability timer
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }

      logger.warn('Subscription closed unexpectedly');
      this.onError(new Error('Subscription closed'));
    }
  }

  /**
   * Handle postgres_changes events.
   * Forwards to onUpdate callback for processing through p-queue.
   * Implements deduplication to prevent duplicate subscriptions from creating conflicts.
   */
  handleChange(payload) {
    const { eventType, new: newRecord, old: oldRecord } = payload;
    const path = newRecord?.path || oldRecord?.path || 'unknown';

    logger.debug(
      { eventType, path, hasNew: !!newRecord, hasOld: !!oldRecord },
      'Realtime change received'
    );

    // Deduplication: check if we've recently processed this exact event
    // Key format: eventType:path:hash:timestamp to uniquely identify each update
    // eventType must be included — DELETE and UPDATE can share the same path:hash:timestamp
    // (DELETE oldRecord mirrors the last UPDATE's newRecord state)
    const hash = newRecord?.content_hash || oldRecord?.content_hash || '';
    const timestamp = newRecord?.updated_at || oldRecord?.updated_at || new Date().toISOString();
    const eventKey = `${eventType}:${path}:${hash}:${timestamp}`;

    if (this.recentEvents.has(eventKey)) {
      logger.debug({ path, hash, eventKey }, 'Duplicate event detected, skipping');
      return; // Skip duplicate event
    }

    // Track this event (with 10-second TTL to catch rapid duplicates)
    this.recentEvents.set(eventKey, Date.now());

    // LRU eviction: remove old entries if cache exceeds limit
    if (this.recentEvents.size > this.maxCacheSize) {
      const now = Date.now();
      const tenSecondsAgo = now - 10000;

      // Remove entries older than 10 seconds
      for (const [key, time] of this.recentEvents.entries()) {
        if (time < tenSecondsAgo) {
          this.recentEvents.delete(key);
        }
      }

      // If still too large, remove oldest entries
      if (this.recentEvents.size > this.maxCacheSize) {
        const entriesToDelete = this.recentEvents.size - this.maxCacheSize;
        let deletedCount = 0;

        for (const [key] of this.recentEvents) {
          if (deletedCount >= entriesToDelete) break;
          this.recentEvents.delete(key);
          deletedCount++;
        }

        logger.debug(
          { cacheSize: this.recentEvents.size, evicted: deletedCount },
          'Event deduplication cache eviction'
        );
      }
    }

    // Forward to event processor (added to p-queue for rate limiting)
    this.onUpdate(payload);
  }

  /**
   * Unsubscribe and cleanup Realtime channel.
   * Call during graceful shutdown to cleanup server resources.
   */
  async unsubscribe() {
    if (this.channel) {
      // Cancel stability timer
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }

      logger.info('Removing Realtime subscription');
      await this.supabase.removeChannel(this.channel);
      this.channel = null;
      this.isSubscribed = false;

      // Clear deduplication cache
      this.recentEvents.clear();

      logger.info('Realtime subscription removed');
    }
  }

  /**
   * Get current subscription status.
   * Returns status string: 'SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', or 'UNSUBSCRIBED'.
   * Used by FallbackPoller to detect successful reconnection.
   */
  getStatus() {
    return this.status;
  }
}
