import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

export interface QueueMessage<T = any> {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
}

export class QueueClient {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Read messages from queue with visibility timeout
   * @param queueName Name of the queue
   * @param vt Visibility timeout in seconds
   * @param qty Number of messages to read
   */
  async read<T = any>(
    queueName: string,
    vt: number,
    qty: number
  ): Promise<QueueMessage<T>[]> {
    try {
      const { data, error } = await this.supabase.rpc('queue_read', {
        queue_name: queueName,
        vt,
        qty
      });

      if (error) {
        throw new Error(`queue_read failed: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      logger.error({ error, queueName }, 'Failed to read from queue');
      throw error;
    }
  }

  /**
   * Delete message from queue (successful processing)
   * @param queueName Name of the queue
   * @param msgId Message ID to delete
   */
  async delete(queueName: string, msgId: number): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('queue_delete', {
        queue_name: queueName,
        msg_id: msgId
      });

      if (error) {
        throw new Error(`queue_delete failed: ${error.message}`);
      }
    } catch (error) {
      logger.error({ error, queueName, msgId }, 'Failed to delete message from queue');
      throw error;
    }
  }

  /**
   * Archive message to dead letter queue (max retries exceeded)
   * @param queueName Name of the queue
   * @param msgId Message ID to archive
   */
  async archive(queueName: string, msgId: number): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('queue_archive', {
        queue_name: queueName,
        msg_id: msgId
      });

      if (error) {
        throw new Error(`queue_archive failed: ${error.message}`);
      }
    } catch (error) {
      logger.error({ error, queueName, msgId }, 'Failed to archive message');
      throw error;
    }
  }

  /**
   * Send message to queue
   * @param queueName Name of the queue
   * @param message Message payload
   */
  async send<T = any>(queueName: string, message: T): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('queue_send', {
        queue_name: queueName,
        msg: message
      });

      if (error) {
        throw new Error(`queue_send failed: ${error.message}`);
      }
    } catch (error) {
      logger.error({ error, queueName }, 'Failed to send message to queue');
      throw error;
    }
  }
}
