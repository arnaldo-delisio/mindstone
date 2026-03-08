/**
 * Intelligence Queue Processor
 *
 * Polls the intelligence queue and processes files through:
 * 1. Auto-tagging (Gemini)
 * 2. Summarization (Gemini)
 * 3. MOC threshold check + generation
 */

import { promises as fs } from 'fs';
import { encode } from 'gpt-tokenizer';
import { supabase } from '../services/supabase.js';
import { QueueClient, QueueMessage } from '../utils/queue-client.js';
import { logger } from '../utils/logger.js';
import { generateTags } from '../processors/auto-tagger.js';
import { generateSummary } from '../processors/summarizer.js';
import { checkMOCThreshold } from '../processors/moc-generator.js';
import { decodeHtmlEntities } from '../utils/html-decode.js';
import {
  INTELLIGENCE_QUEUE,
  VISIBILITY_TIMEOUT,
  MAX_RETRIES,
  POLL_INTERVAL
} from '../config.js';

// Queue Processing Types
export interface IntelligenceMessage {
  file_id: string;
  file_path: string;
  user_id: string;
}

export interface FileRecord {
  id: string;
  path: string;
  body: string;
  frontmatter: any;
  intelligence_status: string;
  chunks_status: string;
  user_id: string;
}

const queueClient = new QueueClient(supabase);

/**
 * Write failure details to .failures/ directory and mark file as failed
 */
export async function handleMaxRetries(
  queueName: string,
  message: QueueMessage<any>,
  processor: string,
  error: any
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}-${processor}-${message.message.file_id}.json`;
  const failurePath = `.failures/${fileName}`;

  const failureData = {
    processor,
    error: {
      message: String(error),
      stack: error?.stack || 'No stack trace'
    },
    message: message.message,
    retryCount: message.read_ct,
    timestamp: new Date().toISOString()
  };

  try {
    await fs.writeFile(failurePath, JSON.stringify(failureData, null, 2));
    logger.error({ failurePath, processor, fileId: message.message.file_id }, 'Failure logged');
  } catch (writeError) {
    logger.error({ error: writeError, failurePath }, 'Failed to write failure file');
  }

  try {
    await queueClient.archive(queueName, message.msg_id);
    logger.info({ msgId: message.msg_id, queueName }, 'Message archived to dead letter');
  } catch (archiveError) {
    logger.error({ error: archiveError, msgId: message.msg_id }, 'Failed to archive message');
  }

  const statusField =
    processor === 'intelligence'
      ? 'intelligence_status'
      : processor === 'extraction'
        ? 'extraction_status'
        : 'chunks_status';
  try {
    await supabase
      .from('files')
      .update({ [statusField]: 'failed' })
      .eq('id', message.message.file_id);
  } catch (updateError) {
    logger.error({ error: updateError, fileId: message.message.file_id }, 'Failed to mark file as failed');
  }
}

/**
 * Intelligence queue processor
 */
export async function pollIntelligenceQueue(): Promise<void> {
  logger.info({ queue: INTELLIGENCE_QUEUE }, 'Starting intelligence queue poller');

  while (true) {
    try {
      const messages = await queueClient.read<IntelligenceMessage>(
        INTELLIGENCE_QUEUE,
        VISIBILITY_TIMEOUT,
        1
      );

      if (messages.length === 0) {
        logger.debug({ queue: INTELLIGENCE_QUEUE }, 'No messages in queue');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const message = messages[0];
      const { file_id, file_path, user_id } = message.message;

      // Skip non-markdown files — code files entered via MCP tools should never
      // be processed by the intelligence pipeline.
      if (!file_path.endsWith('.md')) {
        logger.info({ fileId: file_id, filePath: file_path }, 'Skipping non-markdown file (intelligence)');
        await queueClient.delete(INTELLIGENCE_QUEUE, message.msg_id);
        await supabase.from('files').update({ intelligence_status: 'complete' }).eq('id', file_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      logger.info(
        { fileId: file_id, filePath: file_path, attempt: message.read_ct + 1 },
        'Processing intelligence'
      );

      if (message.read_ct >= MAX_RETRIES) {
        logger.error(
          { fileId: file_id, filePath: file_path, retries: message.read_ct },
          'Max retries exceeded'
        );
        await handleMaxRetries(INTELLIGENCE_QUEUE, message, 'intelligence', new Error('Max retries exceeded'));
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const { data: files, error: fetchError } = await supabase
        .from('files')
        .select('id,path,body,frontmatter,intelligence_status,chunks_status,user_id')
        .eq('id', file_id)
        .single();

      if (fetchError || !files) {
        logger.error({ error: fetchError, fileId: file_id }, 'File not found, deleting message');
        await queueClient.delete(INTELLIGENCE_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const file: FileRecord = files;

      await supabase
        .from('files')
        .update({ intelligence_status: 'processing' })
        .eq('id', file_id);

      const title = file.frontmatter?.title || file.path;
      const existingTags = file.frontmatter?.tags || [];
      const existingSummary = file.frontmatter?.summary;

      // Decode HTML entities before processing (defensive fix for legacy files)
      const cleanBody = decodeHtmlEntities(file.body);

      // Only generate tags if missing (saves Gemini quota)
      let newTags: string[] = [];
      if (existingTags.length === 0) {
        logger.info({ fileId: file_id, filePath: file_path }, 'Generating tags (none exist)');
        newTags = await generateTags(cleanBody, title);
      } else {
        logger.info({ fileId: file_id, filePath: file_path, existingCount: existingTags.length }, 'Skipping tag generation (tags already exist)');
      }
      const mergedTags = Array.from(new Set([...existingTags, ...newTags]));

      const tokens = encode(cleanBody).length;

      // Only generate summary if missing (saves Gemini quota)
      let summaryResult = null;
      if (!existingSummary) {
        logger.info({ fileId: file_id, filePath: file_path }, 'Generating summary (none exists)');
        summaryResult = await generateSummary(cleanBody, title, 'queue');
      } else {
        logger.info({ fileId: file_id, filePath: file_path, summaryLength: existingSummary.length }, 'Skipping summary generation (summary already exists)');
      }

      // Build frontmatter with summary at the bottom for better readability
      const { summary: _, ...otherFields } = file.frontmatter;
      const updatedFrontmatter = {
        ...otherFields,
        tags: mergedTags,
        token_count: tokens
      };

      // Add summary last
      if (summaryResult) {
        updatedFrontmatter.summary = summaryResult.summary;
      } else if (existingSummary) {
        updatedFrontmatter.summary = existingSummary;
      }

      const crypto = await import('crypto');
      const fullContent = `---\n${JSON.stringify(updatedFrontmatter, null, 2)}\n---\n\n${file.body}`;
      const newHash = crypto.createHash('sha256').update(fullContent).digest('hex');

      // Sequential processing: Set chunks_status='pending' to trigger embeddings
      // This prevents concurrent memory buildup (intelligence + embeddings on same file)
      await supabase
        .from('files')
        .update({
          frontmatter: updatedFrontmatter,
          intelligence_status: 'complete',
          chunks_status: 'pending',  // Triggers embeddings queue (via DB trigger)
          content_hash: newHash,
          updated_at: new Date().toISOString()
        })
        .eq('id', file_id);

      const effectiveUserId = user_id || file.user_id;
      await checkMOCThreshold(mergedTags, effectiveUserId, supabase);

      await queueClient.delete(INTELLIGENCE_QUEUE, message.msg_id);

      logger.info({ fileId: file_id, filePath: file_path }, 'Intelligence processing complete');

    } catch (error) {
      logger.error({ error, queue: INTELLIGENCE_QUEUE }, 'Intelligence processing error');
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}
