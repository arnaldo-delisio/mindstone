/**
 * Embeddings Queue Processor
 *
 * Polls the embeddings queue and processes files through hierarchical chunking:
 *
 * Phase 1 ('parents'): Split file body into 1536-token parent chunks (no overlap).
 *   Insert all parents into file_chunks with embedding=NULL. Re-queue for phase 2.
 *
 * Phase 2 ('children'): Split each parent into 512-token child chunks (100 token overlap).
 *   Generate embeddings for children in batches of 20. Re-queue until all children done.
 *
 * At search time: query matches child chunk → parent chunk text returned as context.
 *
 * chunk_index convention:
 *   0 .. N_parents-1  → parent rows (parent_chunk_id = NULL, embedding = NULL)
 *   N_parents .. end  → child rows  (parent_chunk_id = parent.id, embedding = vector)
 */

import { supabase } from '../services/supabase.js';
import { QueueClient } from '../utils/queue-client.js';
import { embeddingsLogger } from '../utils/logger.js';
import { chunkTextHierarchical, generateEmbeddings } from '../processors/embeddings.js';
import { handleMaxRetries } from './intelligence.js';
import { decodeHtmlEntities } from '../utils/html-decode.js';
import {
  EMBEDDINGS_QUEUE,
  EMBEDDINGS_BATCH_SIZE,
  VISIBILITY_TIMEOUT,
  MAX_RETRIES,
  POLL_INTERVAL
} from '../config.js';

interface EmbeddingsMessage {
  file_id: string;
  file_path: string;
  user_id: string;
  batch_size?: number;
  phase?: 'parents' | 'children';  // undefined treated as 'parents'
}

const queueClient = new QueueClient(supabase);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

/**
 * Embeddings queue processor
 */
export async function pollEmbeddingsQueue(): Promise<void> {
  embeddingsLogger.info({ queue: EMBEDDINGS_QUEUE }, 'Starting embeddings queue poller');

  while (true) {
    try {
      const messages = await queueClient.read<EmbeddingsMessage>(
        EMBEDDINGS_QUEUE,
        VISIBILITY_TIMEOUT,
        1
      );

      if (messages.length === 0) {
        embeddingsLogger.debug({ queue: EMBEDDINGS_QUEUE }, 'No messages in queue');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const message = messages[0];
      const { file_id, file_path, batch_size = EMBEDDINGS_BATCH_SIZE, phase } = message.message;

      embeddingsLogger.info(
        { fileId: file_id, filePath: file_path, phase: phase ?? 'parents', attempt: message.read_ct + 1 },
        'Processing embeddings'
      );

      if (message.read_ct >= MAX_RETRIES) {
        embeddingsLogger.error(
          { fileId: file_id, filePath: file_path, retries: message.read_ct },
          'Max retries exceeded'
        );
        await handleMaxRetries(EMBEDDINGS_QUEUE, message, 'embeddings', new Error('Max retries exceeded'));
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const { data: files, error: fetchError } = await supabase
        .from('files')
        .select('id,path,body')
        .eq('id', file_id)
        .single();

      if (fetchError || !files) {
        embeddingsLogger.error({ error: fetchError, fileId: file_id }, 'File not found, deleting message');
        await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      await supabase
        .from('files')
        .update({ chunks_status: 'processing' })
        .eq('id', file_id);

      const cleanBody = decodeHtmlEntities(files.body);
      const { parents: parentTexts, children: allChildren } = await chunkTextHierarchical(cleanBody);

      // Empty file guard
      if (allChildren.length === 0) {
        await supabase.from('files').update({ chunks_status: 'complete' }).eq('id', file_id);
        await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
        embeddingsLogger.info({ fileId: file_id }, 'Empty file, marked complete');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      // ── PHASE 1: Insert parent chunks (no embeddings) ─────────────────────
      if (!phase || phase === 'parents') {
        // Idempotency: skip if parents already inserted (e.g. retry after crash)
        const { data: existingParents } = await supabase
          .from('file_chunks')
          .select('id')
          .eq('file_id', file_id)
          .is('parent_chunk_id', null)
          .limit(1);

        if (!existingParents || existingParents.length === 0) {
          const parentRows = parentTexts.map((text, idx) => ({
            file_id,
            chunk_index: idx,
            chunk_text: text,
            embedding: null,
            parent_chunk_id: null,
          }));
          const { error: parentInsertError } = await supabase.from('file_chunks').insert(parentRows);
          if (parentInsertError) throw new Error(`Failed to insert parents: ${parentInsertError.message}`);
          embeddingsLogger.info({ fileId: file_id, parents: parentRows.length }, 'Parent chunks inserted');
        } else {
          embeddingsLogger.debug({ fileId: file_id }, 'Parents already exist, skipping insertion');
        }

        // Re-queue for children phase
        await queueClient.send(EMBEDDINGS_QUEUE, {
          file_id,
          file_path,
          user_id: message.message.user_id,
          batch_size,
          phase: 'children'
        });
        await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      // ── PHASE 2: Process children in batches ──────────────────────────────
      // Load parent chunks to get their IDs (needed for parent_chunk_id FK)
      const { data: parentChunks, error: parentFetchError } = await supabase
        .from('file_chunks')
        .select('id, chunk_index')
        .eq('file_id', file_id)
        .is('parent_chunk_id', null)
        .order('chunk_index', { ascending: true });

      if (parentFetchError || !parentChunks?.length) {
        throw new Error('Parent chunks missing — cannot process children');
      }

      const numParents = parentChunks.length;

      // Count existing children to find resume point (robust across queue restarts)
      const { count: existingChildCount, error: countError } = await supabase
        .from('file_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('file_id', file_id)
        .not('parent_chunk_id', 'is', null);

      if (countError) throw new Error(`Failed to count existing children: ${countError.message}`);

      const startIdx = existingChildCount ?? 0;

      if (startIdx >= allChildren.length) {
        // All children already processed (e.g. duplicate message)
        await supabase.from('files').update({ chunks_status: 'complete' }).eq('id', file_id);
        await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
        embeddingsLogger.info({ fileId: file_id, totalChildren: allChildren.length }, 'Already complete');
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const endIdx = Math.min(startIdx + batch_size, allChildren.length);
      const batchChildren = allChildren.slice(startIdx, endIdx);
      const batchTexts = batchChildren.map(c => c.text);

      embeddingsLogger.info(
        { fileId: file_id, batch: `${startIdx}-${endIdx - 1}`, total: allChildren.length },
        'Processing child batch'
      );

      const embeddings = await generateEmbeddings(batchTexts, OPENAI_API_KEY, embeddingsLogger);

      const chunksToInsert = batchChildren.map((child, i) => ({
        file_id,
        chunk_index: numParents + startIdx + i,  // global index: parents first, then children
        chunk_text: child.text,
        embedding: embeddings[i],
        parent_chunk_id: parentChunks[child.parentIndex].id,
      }));

      const { error: insertError } = await supabase.from('file_chunks').insert(chunksToInsert);
      if (insertError) throw new Error(`Failed to insert children: ${insertError.message}`);

      // Clear large arrays to help garbage collection
      chunksToInsert.length = 0;
      batchTexts.length = 0;
      embeddings.length = 0;

      if (endIdx < allChildren.length) {
        embeddingsLogger.info(
          { fileId: file_id, processed: endIdx, remaining: allChildren.length - endIdx },
          'Batch complete, re-queuing'
        );
        await queueClient.send(EMBEDDINGS_QUEUE, {
          file_id,
          file_path,
          user_id: message.message.user_id,
          batch_size,
          phase: 'children'
        });
        await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      await supabase.from('files').update({ chunks_status: 'complete' }).eq('id', file_id);
      await queueClient.delete(EMBEDDINGS_QUEUE, message.msg_id);
      embeddingsLogger.info(
        { fileId: file_id, filePath: file_path, parents: numParents, children: allChildren.length },
        'Hierarchical embeddings complete'
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      embeddingsLogger.error(
        { error: errorMessage, stack: errorStack, queue: EMBEDDINGS_QUEUE },
        'Embeddings processing error'
      );

      // Note: Message will be retried automatically by queue system
      // Max retries handler will set status to 'failed' and archive message
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}
