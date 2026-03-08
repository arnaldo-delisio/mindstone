/**
 * Read Note - Retrieve full file contents by path with optional search
 *
 * Provides exact path lookup for viewing vault files from mobile.
 * Optional search parameter filters to relevant sections in large files.
 */

import { supabase } from '../../services/supabase.js';
import yaml from 'js-yaml';
import { generateEmbedding, isEmbeddingAvailable } from '../../processors/embeddings.js';
import { USER_ID } from '../../config.js';

interface FileData {
  id: string;
  path: string;
  body: string;
  frontmatter: Record<string, any> | null;
  updated_at: string;
}

/**
 * Read a single vault file by exact path match or direct id lookup
 */
async function readNote(path: string, id?: string): Promise<FileData | null> {
  if (!path || typeof path !== 'string') {
    throw new Error('Invalid path parameter: must be a non-empty string');
  }

  try {
    // Fast-path: if id provided, skip path-based lookup
    if (id) {
      const { data, error } = await supabase
        .from('files')
        .select('id, path, body, frontmatter, updated_at')
        .eq('id', id)
        .eq('user_id', USER_ID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw new Error(`Database query failed: ${error.message}`);
      }

      return data;
    }

    // Query files for exact path match
    const { data, error } = await supabase
      .from('files')
      .select('id, path, body, frontmatter, updated_at')
      .eq('path', path)
      .single();

    if (error) {
      // Handle not found vs other errors
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Database query failed: ${error.message}`);
    }

    return data;
  } catch (error) {
    throw new Error(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Format frontmatter as YAML string
 */
function formatFrontmatter(frontmatter: Record<string, any> | null): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return '';
  }

  try {
    return yaml.dump(frontmatter, {
      indent: 2,
      lineWidth: -1, // Don't wrap lines
      noRefs: true
    }).trim();
  } catch (error) {
    return JSON.stringify(frontmatter, null, 2);
  }
}

/**
 * Search within file content using simple text matching (for small files)
 */
function grepInFile(fileData: FileData, searchQuery: string): string {
  const lines = fileData.body.split('\n');
  const searchLower = searchQuery.toLowerCase();
  const matches: { lineNum: number; line: string; context: string[] }[] = [];

  // Find all matching lines with context
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(searchLower)) {
      const contextBefore = lines.slice(Math.max(0, i - 2), i);
      const contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 3));
      matches.push({
        lineNum: i + 1,
        line: lines[i],
        context: [...contextBefore, lines[i], ...contextAfter]
      });
    }
  }

  if (matches.length === 0) {
    return `No matches found for "${searchQuery}" in ${fileData.path}`;
  }

  // Format output
  let output = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${searchQuery}" in ${fileData.path}:\n\n`;

  matches.slice(0, 10).forEach((match, idx) => {
    output += `--- Match ${idx + 1} (line ${match.lineNum}) ---\n`;
    output += match.context.join('\n');
    output += '\n\n';
  });

  if (matches.length > 10) {
    output += `... and ${matches.length - 10} more matches\n`;
  }

  return output;
}

/**
 * Search within file chunks using semantic + keyword search (for large files)
 * Implements smart chunk sampling: top matches + context chunks (beginning/middle/end)
 */
async function searchInChunks(filePath: string, searchQuery: string, limit: number = 10): Promise<string> {
  // Generate query embedding if available
  let queryEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch (err) {
      console.warn('[ReadNote] Failed to generate embedding, using keyword-only:', err);
    }
  }

  // Get file ID and total chunk count
  const { data: fileData, error: fileError } = await supabase
    .from('files')
    .select('id, path')
    .eq('path', filePath)
    .single();

  if (fileError || !fileData) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Get total chunk count for this file
  const { count: totalChunks, error: countError } = await supabase
    .from('file_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('file_id', fileData.id);

  if (countError) {
    throw new Error(`Failed to count chunks: ${countError.message}`);
  }

  const totalChunkCount = totalChunks || 0;

  if (totalChunkCount === 0) {
    return `No searchable chunks found for "${searchQuery}" in ${filePath}\n\nFile may not be indexed yet.`;
  }

  // Search chunks for this specific file
  const searchLower = searchQuery.toLowerCase();

  // Keyword search in chunks (get more than limit to account for context chunk overlap)
  const { data: keywordChunks, error: kwError } = await supabase
    .from('file_chunks')
    .select('chunk_index, chunk_text')
    .eq('file_id', fileData.id)
    .ilike('chunk_text', `%${searchQuery}%`)
    .order('chunk_index', { ascending: true })
    .limit(limit);

  if (kwError) {
    throw new Error(`Keyword search failed: ${kwError.message}`);
  }

  let topMatches = keywordChunks || [];

  // Semantic search in chunks (if embedding available)
  if (queryEmbedding) {
    const { data: semanticChunks, error: semError } = await supabase
      .from('file_chunks')
      .select('chunk_index, chunk_text, embedding')
      .eq('file_id', fileData.id)
      .not('embedding', 'is', null)
      .limit(limit);

    if (!semError && semanticChunks) {
      // Calculate cosine similarity for each chunk
      const scoredChunks = semanticChunks.map(chunk => {
        const similarity = cosineSimilarity(queryEmbedding!, chunk.embedding);
        return { ...chunk, score: similarity };
      });

      // Merge with keyword results (deduplicate by chunk_index)
      const keywordIndices = new Set(topMatches.map(r => r.chunk_index));
      scoredChunks
        .filter(c => !keywordIndices.has(c.chunk_index))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, limit - topMatches.length))
        .forEach(c => topMatches.push(c));
    }
  }

  // Add context chunks for coverage (beginning/middle/end)
  const matchedIndices = new Set(topMatches.map(c => c.chunk_index));
  const contextIndices: number[] = [];

  // Beginning: chunk 0 (if not already matched)
  if (!matchedIndices.has(0) && topMatches.length < limit) {
    contextIndices.push(0);
  }

  // Middle: chunk around totalChunks/2 (if not already matched)
  const middleIdx = Math.floor(totalChunkCount / 2);
  if (!matchedIndices.has(middleIdx) && topMatches.length + contextIndices.length < limit) {
    contextIndices.push(middleIdx);
  }

  // End: last chunk (if not already matched)
  const endIdx = totalChunkCount - 1;
  if (!matchedIndices.has(endIdx) && topMatches.length + contextIndices.length < limit && endIdx > 0) {
    contextIndices.push(endIdx);
  }

  // Fetch context chunks
  let contextChunks: any[] = [];
  if (contextIndices.length > 0) {
    const { data: chunks, error: contextError } = await supabase
      .from('file_chunks')
      .select('chunk_index, chunk_text')
      .eq('file_id', fileData.id)
      .in('chunk_index', contextIndices);

    if (!contextError && chunks) {
      contextChunks = chunks;
    }
  }

  // Merge and deduplicate all chunks
  const allChunks = [...topMatches, ...contextChunks];
  const uniqueChunks = Array.from(
    new Map(allChunks.map(c => [c.chunk_index, c])).values()
  ).sort((a, b) => a.chunk_index - b.chunk_index);

  if (uniqueChunks.length === 0) {
    return `No matches found for "${searchQuery}" in ${filePath}\n\nTry different keywords or read the full file.`;
  }

  // Format output with smart chunk sampling context
  const totalChars = uniqueChunks.reduce((sum, c) => sum + c.chunk_text.length, 0);
  let output = `Found ${uniqueChunks.length} relevant section${uniqueChunks.length === 1 ? '' : 's'} for "${searchQuery}" in ${filePath}:\n\n`;

  // Show chunk distribution
  const chunkLabels = uniqueChunks.map(c => {
    if (c.chunk_index === 0) return `0 (intro)`;
    if (c.chunk_index === middleIdx) return `${c.chunk_index} (middle)`;
    if (c.chunk_index === endIdx) return `${c.chunk_index} (end)`;
    return `${c.chunk_index}`;
  }).join(', ');

  output += `Showing chunks: ${chunkLabels}\n`;
  output += `Total: ${totalChunkCount} chunks in file (~${(totalChars).toLocaleString()} chars)\n\n`;

  uniqueChunks.forEach((chunk, idx) => {
    let label = 'Relevant Match';
    if (chunk.chunk_index === 0) label = 'Introduction';
    else if (chunk.chunk_index === middleIdx) label = 'Middle Section';
    else if (chunk.chunk_index === endIdx) label = 'End Section';

    output += `--- Section ${idx + 1}: ${label} (chunk ${chunk.chunk_index}/${totalChunkCount - 1}) ---\n`;
    output += chunk.chunk_text;
    output += '\n\n';
  });

  // Multi-turn tips
  output += `Multi-turn tips:\n`;
  output += `- Ask follow-up questions to explore specific topics\n`;
  output += `- Request "chunks around ${middleIdx}" for more context near a specific section\n`;
  output += `- Search for different keywords to find other relevant sections`;

  return output;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * MCP tool handler for read_note
 */
export async function readNoteTool(args: {
  path: string;
  search?: string;
  id?: string;
}): Promise<string> {
  try {
  const { path, search, id } = args;

  const fileData = await readNote(path, id);

  if (!fileData) {
    return `File not found: ${path}`;
  }

  const body = fileData.body || '';
  const bodyLength = body.length;
  const maxBodyLength = 50000; // ~50k chars for mobile context

  // Search mode: filter to relevant sections
  if (search) {
    if (bodyLength < maxBodyLength) {
      // Small file: use simple grep
      return grepInFile(fileData, search);
    } else {
      // Large file: use semantic chunk search
      return await searchInChunks(path, search);
    }
  }

  // Read mode: return full file with smart truncation
  let output = '';

  if (fileData.frontmatter && Object.keys(fileData.frontmatter).length > 0) {
    output += '---\n';
    output += formatFrontmatter(fileData.frontmatter);
    output += '\n---\n\n';
  }

  // Smart truncation for large files
  if (bodyLength > maxBodyLength) {
    output += body.substring(0, maxBodyLength);
    output += `\n\n--- Content Truncated ---\n`;
    output += `Total: ${bodyLength.toLocaleString()} chars, showing first ${maxBodyLength.toLocaleString()} chars\n`;
    output += `Use read_note with search parameter to find specific sections:\n`;
    output += `   read_note(path: "${path}", search: "your keywords")`;
  } else {
    output += body;
  }

  // Add metadata footer
  const updatedDate = new Date(fileData.updated_at).toLocaleString();
  output += `\n\n---\nID: ${fileData.id}\nPath: ${fileData.path}\nLast updated: ${updatedDate}`;

  return output;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `read_note error: ${msg}`;
  }
}
