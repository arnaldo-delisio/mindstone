/**
 * Extraction Queue Processor
 *
 * Polls the extraction queue and processes large files (>20MB) through:
 * 1. Gemini File API upload
 * 2. Content extraction
 * 3. Frontmatter update
 * 4. Sequential trigger to intelligence queue
 */

import { supabase } from '../services/supabase.js';
import { QueueClient, QueueMessage } from '../utils/queue-client.js';
import { logger } from '../utils/logger.js';
import { GeminiExtractor } from '../extractors/gemini-extractor.js';
import {
  EXTRACTION_QUEUE,
  VISIBILITY_TIMEOUT,
  MAX_RETRIES,
  POLL_INTERVAL
} from '../config.js';
import { handleMaxRetries } from './intelligence.js';

// Queue Processing Types
export interface ExtractionMessage {
  file_id: string;
  file_path: string;
}

export interface FileRecord {
  id: string;
  path: string;
  body: string;
  frontmatter: any;
  extraction_status: string;
  intelligence_status: string;
  chunks_status: string;
}

const queueClient = new QueueClient(supabase);

/**
 * Extraction queue processor
 */
export async function pollExtractionQueue(): Promise<void> {
  logger.info({ queue: EXTRACTION_QUEUE }, 'Starting extraction queue poller');

  const geminiExtractor = new GeminiExtractor();

  while (true) {
    try {
      const messages = await queueClient.read<ExtractionMessage>(
        EXTRACTION_QUEUE,
        VISIBILITY_TIMEOUT,
        1
      );

      if (messages.length === 0) {
        logger.debug({ queue: EXTRACTION_QUEUE }, 'No messages in queue');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const message = messages[0];
      const { file_id, file_path } = message.message;

      logger.info(
        { fileId: file_id, filePath: file_path, attempt: message.read_ct + 1 },
        'Processing extraction'
      );

      // Check max retries
      if (message.read_ct >= MAX_RETRIES) {
        logger.error(
          { fileId: file_id, filePath: file_path, retries: message.read_ct },
          'Max retries exceeded'
        );
        await handleMaxRetries(EXTRACTION_QUEUE, message, 'extraction', new Error('Max retries exceeded'));
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      // Fetch file from database
      const { data: files, error: fetchError } = await supabase
        .from('files')
        .select('id,path,body,frontmatter,extraction_status,intelligence_status,chunks_status')
        .eq('id', file_id)
        .single();

      if (fetchError || !files) {
        logger.error({ error: fetchError, fileId: file_id }, 'File not found, deleting message');
        await queueClient.delete(EXTRACTION_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const file: FileRecord = files;

      // Check if file has temp_extraction_data
      const tempData = file.frontmatter?.temp_extraction_data;
      if (!tempData || !tempData.buffer_base64) {
        logger.error(
          { fileId: file_id, filePath: file_path },
          'Missing temp_extraction_data, marking as failed'
        );
        await supabase
          .from('files')
          .update({ extraction_status: 'failed' })
          .eq('id', file_id);
        await queueClient.delete(EXTRACTION_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      // Mark as processing
      await supabase
        .from('files')
        .update({ extraction_status: 'processing' })
        .eq('id', file_id);

      logger.info(
        { fileId: file_id, filePath: file_path, size: tempData.buffer_base64.length },
        'Decoding buffer and extracting content'
      );

      // Decode buffer from base64
      const buffer = Buffer.from(tempData.buffer_base64, 'base64');

      // Extract content using Gemini File API
      const extractionResult = await geminiExtractor.extractFromBuffer(
        buffer,
        tempData.mime_type,
        tempData.file_name
      );

      logger.info(
        {
          fileId: file_id,
          filePath: file_path,
          wordCount: extractionResult.wordCount,
          pageCount: extractionResult.pageCount
        },
        'Extraction complete'
      );

      // Update frontmatter (remove temp data, add extraction metadata)
      const updatedFrontmatter = {
        ...file.frontmatter,
        title: extractionResult.title,
        type: extractionResult.sourceType,
        word_count: extractionResult.wordCount,
        page_count: extractionResult.pageCount,
        file_size: extractionResult.fileSize
      };

      // Add optional metadata if available
      if (extractionResult.author) {
        updatedFrontmatter.author = extractionResult.author;
      }
      if (extractionResult.publishedDate) {
        updatedFrontmatter.published_date = extractionResult.publishedDate;
      }

      // Remove temp_extraction_data
      delete updatedFrontmatter.temp_extraction_data;

      // Calculate content hash
      const crypto = await import('crypto');
      const fullContent = `---\n${JSON.stringify(updatedFrontmatter, null, 2)}\n---\n\n${extractionResult.content}`;
      const newHash = crypto.createHash('sha256').update(fullContent).digest('hex');

      // Update file: content + metadata + trigger intelligence queue
      await supabase
        .from('files')
        .update({
          body: extractionResult.content,
          frontmatter: updatedFrontmatter,
          extraction_status: 'complete',
          intelligence_status: 'pending',  // Triggers intelligence queue (via DB trigger)
          content_hash: newHash,
          updated_at: new Date().toISOString()
        })
        .eq('id', file_id);

      // Delete message from queue
      await queueClient.delete(EXTRACTION_QUEUE, message.msg_id);

      logger.info({ fileId: file_id, filePath: file_path }, 'Extraction processing complete');

    } catch (error) {
      logger.error({ error, queue: EXTRACTION_QUEUE }, 'Extraction processing error');
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}
