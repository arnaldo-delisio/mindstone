/**
 * Unified Embeddings Processor
 *
 * Merged from 3 sources:
 * - mcp/services/embeddings.ts (sentence-aware chunking, single embedding, chunked embeddings)
 * - processors/embeddings-chunker.ts (simple chunking - replaced by sentence-aware)
 * - processors/embeddings-generator.ts (batched generation with retry)
 *
 * Provides:
 * - chunkText(): Sentence-aware text chunking with overlap
 * - chunkTextHierarchical(): Two-pass hierarchical chunking (parents + children)
 * - generateEmbedding(): Single text → embedding vector (for search queries)
 * - generateEmbeddings(): Batch text[] → embedding vectors (for queue processing)
 * - generateChunkedEmbeddings(): Full pipeline: chunk + embed (for inline processing)
 * - isEmbeddingAvailable(): Check if OPENAI_API_KEY is set
 */

import OpenAI from 'openai';
import type { Logger } from 'pino';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { encodingForModel } from 'js-tiktoken';

const BATCH_SIZE = 20;

// Lazy-initialized OpenAI client (shared across all functions)
let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) return null;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * Check if embedding generation is available
 */
export function isEmbeddingAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Chunk text into smaller segments for embedding generation
 * Uses LangChain's RecursiveCharacterTextSplitter with markdown-aware separators
 *
 * Strategy:
 * - Token-based sizing using tiktoken (accurate for OpenAI models)
 * - Target chunk size: ~1536 tokens (proven baseline from prior chunker)
 * - Overlap: ~200 tokens (~13% overlap prevents context loss)
 * - Markdown-aware splitting: headers → paragraphs → sentences → spaces
 * - Better than custom chunker: respects document structure, handles edge cases
 */
export async function chunkText(
  text: string,
  maxChunkTokens: number = 1536,
  overlapTokens: number = 200
): Promise<string[]> {
  // Reuse encoding instance across all length function calls (CRITICAL for performance)
  // Creating new encoding per call was causing 10+ minute processing times for migration
  const encoding = encodingForModel('text-embedding-3-small');

  // Quick path: if text is small, no chunking needed
  const tokens = encoding.encode(text);

  if (tokens.length <= maxChunkTokens) {
    return [text];
  }

  // Create splitter with token-based length function
  // IMPORTANT: Reuse encoding instance - creating new encoding per chunk is 100x+ slower
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: maxChunkTokens,
    chunkOverlap: overlapTokens,
    lengthFunction: (text: string) => {
      return encoding.encode(text).length;
    },
    // Markdown-aware separators (RecursiveCharacterTextSplitter default is good)
    // Priority: headers (##, ###) → paragraphs (\n\n) → sentences → spaces
  });

  return await textSplitter.splitText(text);
}

/**
 * Chunk text hierarchically for small-to-big retrieval.
 *
 * Parents (1536 tokens, no overlap): semantic section containers.
 *   Stored in file_chunks with embedding=NULL. Not searched directly.
 *
 * Children (512 tokens, 100 token overlap within each parent): precision retrieval units.
 *   Stored in file_chunks with embeddings. Searched at query time.
 *   At search time: best child found → parent text returned as context.
 *
 * Single encoding instance shared across all splits (CRITICAL for performance —
 * creating per-call was causing 10+ min delays).
 */
export async function chunkTextHierarchical(text: string): Promise<{
  parents: string[];
  children: Array<{ parentIndex: number; text: string }>;
}> {
  if (!text || !text.trim()) {
    return { parents: [], children: [] };
  }

  // Single encoding instance for all splits (reuse = critical for performance)
  const encoding = encodingForModel('text-embedding-3-small');
  const lengthFn = (t: string) => encoding.encode(t).length;

  // Pass 1: parent chunks (1536 tokens, NO overlap — clean section boundaries)
  const parentSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1536,
    chunkOverlap: 0,
    lengthFunction: lengthFn,
  });
  const parents = await parentSplitter.splitText(text);

  // Pass 2: child chunks within each parent (512 tokens, 100 token overlap)
  const childSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 512,
    chunkOverlap: 100,
    lengthFunction: lengthFn,
  });

  const children: Array<{ parentIndex: number; text: string }> = [];
  for (let i = 0; i < parents.length; i++) {
    const childTexts = await childSplitter.splitText(parents[i]);
    for (const childText of childTexts) {
      children.push({ parentIndex: i, text: childText });
    }
  }

  return { parents, children };
}

/**
 * Generate embedding for a single text using OpenAI text-embedding-3-small
 * Truncates to ~7500 tokens (30000 chars) to stay within 8191 token limit
 *
 * Used for search queries where only one embedding is needed.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY not set - cannot generate embedding');
  }

  const truncated = text.slice(0, 30000);

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: truncated
  });

  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple text chunks in batches of 20 with retry
 *
 * Used by queue processor for batch processing.
 * Accepts explicit API key and logger for queue context.
 */
export async function generateEmbeddings(
  chunks: string[],
  openaiKey: string,
  logger: Logger
): Promise<number[][]> {
  const client = new OpenAI({ apiKey: openaiKey });
  const embeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    logger.debug(
      { batch: batchNum, total: totalBatches, chunks: batch.length },
      'Processing embeddings batch'
    );

    try {
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch
      });

      const batchEmbeddings = response.data.map((item) => item.embedding);
      embeddings.push(...batchEmbeddings);

      logger.debug(
        { batch: batchNum, embeddings: batchEmbeddings.length },
        'Batch complete'
      );
    } catch (error) {
      logger.error({ error, batch: batchNum }, 'Embeddings batch failed');

      // Retry once on transient failure
      try {
        logger.info({ batch: batchNum }, 'Retrying failed batch');
        const retryResponse = await client.embeddings.create({
          model: 'text-embedding-3-small',
          input: batch
        });

        const batchEmbeddings = retryResponse.data.map((item) => item.embedding);
        embeddings.push(...batchEmbeddings);

        logger.info({ batch: batchNum }, 'Retry successful');
      } catch (retryError) {
        logger.error({ error: retryError, batch: batchNum }, 'Retry failed');
        throw new Error(
          `Embeddings generation failed for batch ${batchNum}: ${String(retryError)}`
        );
      }
    }
  }

  logger.info({ total: embeddings.length }, 'All embeddings generated');
  return embeddings;
}

/**
 * Generate chunked embeddings for long text content
 * Splits text into chunks and generates embeddings for each
 *
 * Used by background-embeddings for inline processing of small files.
 */
export async function generateChunkedEmbeddings(
  text: string
): Promise<Array<{ chunk_index: number; chunk_text: string; embedding: number[] }>> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY not set - cannot generate embeddings');
  }

  const chunks = await chunkText(text);
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunks[i]
      });

      results.push({
        chunk_index: i,
        chunk_text: chunks[i],
        embedding: response.data[0].embedding
      });
    } catch (error) {
      console.error(`Failed to generate embedding for chunk ${i}:`, error);
      continue;
    }
  }

  if (results.length === 0) {
    throw new Error('Failed to generate any embeddings for chunks');
  }

  return results;
}
