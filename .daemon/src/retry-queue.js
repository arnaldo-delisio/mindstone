import pRetry from 'p-retry';
import PQueue from 'p-queue';
import writeFileAtomic from 'write-file-atomic';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { config } from './config.js';

export class RetryQueue {
  constructor(queuePath, syncFn) {
    this.queuePath = queuePath;
    this.syncFn = syncFn; // Function to retry (syncFile from syncer.js)
    this.queue = new PQueue({
      concurrency: config.queue.concurrency,     // 3
      intervalCap: config.queue.intervalCap,     // 30
      interval: config.queue.interval            // 60000ms (1 minute)
    });
    this.operations = new Map();
  }

  async load() {
    try {
      const data = await readFile(this.queuePath, 'utf8');
      const operations = JSON.parse(data);
      operations.forEach(op => this.operations.set(op.id, op));
      logger.info({ count: operations.length }, 'Loaded retry queue');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error({ error }, 'Failed to load retry queue');
        throw error;
      }
      logger.info('No existing retry queue found, starting fresh');
    }
  }

  async save() {
    const operations = Array.from(this.operations.values());
    await writeFileAtomic(
      this.queuePath,
      JSON.stringify(operations, null, 2)
    );
  }

  async add(operation) {
    const id = `${operation.type}-${operation.path}-${Date.now()}`;
    const queuedOp = {
      ...operation,
      id,
      attempts: 0,
      addedAt: Date.now(),
      lastAttempt: null
    };

    this.operations.set(id, queuedOp);
    await this.save();

    logger.info({ operationId: id, path: operation.path }, 'Added to retry queue');

    // Execute with retry logic
    this.queue.add(() => this.execute(id));
  }

  async execute(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      logger.warn({ operationId }, 'Operation not found in queue');
      return;
    }

    try {
      let result;
      await pRetry(
        async () => {
          operation.attempts++;
          operation.lastAttempt = Date.now();
          await this.save();

          logger.debug({ operationId, attempt: operation.attempts }, 'Retrying operation');

          // Call the sync function (syncFile) and capture result
          result = await this.syncFn(operation.path);

          // If file was deleted, throw special error to exit retry loop early
          if (result?.skipped && result.reason === 'file_not_found') {
            const skipError = new Error('File not found, skipping operation');
            skipError.code = 'SKIP_FILE_NOT_FOUND';
            throw skipError;
          }
        },
        {
          retries: config.retry.maxRetries,          // 10
          factor: 2,                                  // Exponential backoff
          minTimeout: config.retry.minTimeout,       // 1000ms
          maxTimeout: config.retry.maxTimeout,       // 60000ms
          maxRetryTime: config.retry.maxRetryTime,   // 600000ms (10 min)
          onFailedAttempt: error => {
            // Don't log retry for file_not_found (we'll handle it below)
            if (error.code !== 'SKIP_FILE_NOT_FOUND') {
              logger.warn(
                {
                  operationId,
                  attempt: error.attemptNumber,
                  retriesLeft: error.retriesLeft,
                  error: error.message
                },
                'Retry attempt failed'
              );
            }
          }
        }
      );

      // Success - remove from queue (REL-03)
      this.operations.delete(operationId);
      await this.save();
      logger.info({ operationId }, 'Operation completed, removed from queue');

    } catch (error) {
      // Handle file not found - remove from queue gracefully
      if (error.code === 'SKIP_FILE_NOT_FOUND') {
        this.operations.delete(operationId);
        await this.save();
        logger.info({ operationId, path: operation.path }, 'File no longer exists, removed from queue');
        return;
      }

      logger.error(
        { operationId, attempts: operation.attempts, error: error.message },
        'Operation failed permanently after max retries'
      );
      // Keep in queue for manual inspection
      // Could add max age cleanup in future phases
    }
  }

  // Process queue on startup (REL-04)
  async processAll() {
    const operations = Array.from(this.operations.keys());
    logger.info({ count: operations.length }, 'Processing queued operations from previous session');

    for (const id of operations) {
      this.queue.add(() => this.execute(id));
    }
  }

  // Get queue size for health monitoring
  getSize() {
    return this.operations.size;
  }

  // Get failed operation count
  getFailedCount() {
    return Array.from(this.operations.values())
      .filter(op => op.attempts >= config.retry.maxRetries)
      .length;
  }
}
