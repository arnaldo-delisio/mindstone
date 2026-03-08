/**
 * Search Notes - Hybrid keyword + semantic search across vault content
 *
 * Uses hybrid_search RPC function combining:
 * - ILIKE keyword matching for exact term hits
 * - pgvector embedding similarity for semantic matches
 * - Reciprocal Rank Fusion (RRF) for result ranking
 *
 * Supports advanced filters:
 * - file_type: library, learnings, daily, mocs
 * - tags: array (OR within array)
 * - author: matches author field OR guests array
 * - source: youtube, article, pdf (library only)
 * - after/before: date range filtering
 */

import { supabase } from '../../services/supabase.js';
import { generateEmbedding, isEmbeddingAvailable } from '../../processors/embeddings.js';
import { USER_ID } from '../../config.js';

interface SearchResult {
  id: string;
  path: string;
  snippet: string;
  tags: string[];
  updated_at: string;
  score?: number;  // RRF score from hybrid search
  moc_memberships?: string[];  // MOC topics this file belongs to
}

interface MOCInfo {
  topic: string;
  content: string;
  item_count: number;
}

interface SearchResponse {
  mocs?: MOCInfo[];
  results: SearchResult[];
  total_count: number;
  showing: number;
  note?: string;
}

interface SearchFilters {
  file_type?: 'library' | 'learnings' | 'daily' | 'mocs';
  tags?: string[];
  author?: string;
  source?: 'youtube' | 'article' | 'pdf';
  after?: string;  // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  date_range?: 'today' | 'yesterday' | 'this_week' | 'this_month';
  sort?: 'newest_first' | 'oldest_first' | 'relevance';
}

/**
 * Search vault files using hybrid keyword + semantic search with advanced filters
 *
 * @param query - Search query text (optional for filtered browse)
 * @param limit - Maximum results (1-20)
 * @param filters - Advanced filters
 */
export async function searchNotes(
  query: string | null,
  limit: number = 10,
  filters?: SearchFilters
): Promise<SearchResponse> {

  // Enforce max limit to prevent overwhelming mobile context
  const safeLimit = Math.min(Math.max(1, limit), 20);

  try {
    // Convert date_range preset to after/before if provided
    if (filters?.date_range) {
      const dateRange = convertDateRangePreset(filters.date_range);
      filters.after = dateRange.after;
      if (dateRange.before) {
        filters.before = dateRange.before;
      }
    }

    // Validate date filters
    if (filters?.after && !isValidDate(filters.after)) {
      throw new Error(`Invalid after date: must be YYYY-MM-DD format`);
    }
    if (filters?.before && !isValidDate(filters.before)) {
      throw new Error(`Invalid before date: must be YYYY-MM-DD format`);
    }

    // Determine sort preference
    const sortPreference = filters?.sort || (query ? 'relevance' : 'newest_first');

    // If query provided: use hybrid search with smart recovery
    if (query) {
      return await searchWithRecovery(query, safeLimit, filters, sortPreference);
    }

    // No query: filtered browse (direct SELECT with filters)
    return await filteredBrowse(safeLimit, filters, sortPreference);
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate YYYY-MM-DD date format
 */
function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;

  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * Convert date_range preset to after/before dates
 */
function convertDateRangePreset(preset: string): { after: string; before?: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const formatDate = (date: Date): string => {
    return date.toISOString().split('T')[0];
  };

  switch (preset) {
    case 'today':
      return { after: formatDate(today) };

    case 'yesterday': {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const dayAfterYesterday = new Date(yesterday);
      dayAfterYesterday.setDate(dayAfterYesterday.getDate() + 1);
      return {
        after: formatDate(yesterday),
        before: formatDate(dayAfterYesterday)
      };
    }

    case 'this_week': {
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return { after: formatDate(weekAgo) };
    }

    case 'this_month': {
      const monthAgo = new Date(today);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return { after: formatDate(monthAgo) };
    }

    default:
      throw new Error(`Invalid date_range preset: ${preset}`);
  }
}

/**
 * Interpret tag logic from query text
 * - If query contains "or" (case-insensitive), use OR logic
 * - If query contains "and" (case-insensitive), use AND logic
 * - Default: OR (any tag matches)
 */
function interpretTagLogic(tags: string[], query?: string): 'AND' | 'OR' {
  if (!query) return 'OR';

  // If query contains "or" (case-insensitive), use OR logic
  if (/\bor\b/i.test(query)) return 'OR';

  // If query contains "and" (case-insensitive), use AND logic
  if (/\band\b/i.test(query)) return 'AND';

  // Default: OR (any tag matches)
  return 'OR';
}

/**
 * Build SQL filters from SearchFilters object
 */
function buildFilters(builder: any, filters?: SearchFilters, userId: string = USER_ID, query?: string) {
  // Always filter by user_id
  builder = builder.eq('user_id', userId);

  // Exclude system files from search results
  const systemFiles = ['CLAUDE.md', 'README.md', '.gitignore'];
  builder = builder.not('path', 'in', `(${systemFiles.join(',')})`);

  if (!filters) return builder;

  // File type filter (path prefix)
  if (filters.file_type) {
    builder = builder.like('path', `${filters.file_type}/%`);
  }

  // Tag filter with AND/OR logic interpretation
  if (filters.tags && filters.tags.length > 0) {
    const logic = interpretTagLogic(filters.tags, query);

    if (logic === 'AND') {
      // All tags must be present (JSONB @> operator)
      builder = builder.contains('frontmatter->tags', filters.tags);
      console.log(`[Filter] Tag logic: AND (${filters.tags.join(', ')})`);
    } else {
      // Any tag matches (overlaps - existing behavior)
      builder = builder.overlaps('frontmatter->tags', filters.tags);
      console.log(`[Filter] Tag logic: OR (${filters.tags.join(', ')})`);
    }
  }

  // Author filter (fuzzy matching with pg_trgm)
  if (filters.author) {
    // Dynamic similarity threshold based on query length
    // Short queries (≤3 chars): strict 0.5 to avoid false positives
    // Medium queries (4-10 chars): default 0.3 for balanced matching
    // Long queries (11+ chars): relaxed 0.2 for partial matches
    const threshold = filters.author.length <= 3 ? 0.5 :
                     filters.author.length <= 10 ? 0.3 : 0.2;

    console.log(`[Filter] Using fuzzy author matching with threshold ${threshold}`);

    // Combine: exact match OR fuzzy similarity OR guests array
    // word_similarity is better for partial matches ("Huber" in "Andrew Huberman Lab")
    builder = builder.or(
      `frontmatter->>author.eq.${filters.author},` +
      `word_similarity(${filters.author},frontmatter->>author).gt.${threshold},` +
      `frontmatter->guests.cs.{${filters.author}}`
    );
  }

  // Source type filter (library only)
  if (filters.source) {
    builder = builder.like('path', 'library/%');
    builder = builder.eq('frontmatter->>source_type', filters.source);
  }

  // Date range filters - always use created_at (when YOU captured it)
  // published_date is just metadata about the source content
  if (filters.after) {
    builder = builder.gte('created_at', filters.after);
  }
  if (filters.before) {
    builder = builder.lte('created_at', filters.before);
  }

  return builder;
}

/**
 * Decode HTML entities in text
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Calculate adaptive result limit based on total matches
 * - ≤20 results: return all (complete view)
 * - 21-50 results: return top 30 (focused but comprehensive)
 * - 51+ results: return top 50 (prevents overwhelming context)
 */
function getAdaptiveLimit(totalResults: number): number {
  if (totalResults <= 20) return totalResults;
  if (totalResults <= 50) return 30;
  return 50;
}

/**
 * Extract snippet from content (300 chars around match or first 300 chars)
 */
function extractSnippet(content: string, query?: string): string {
  if (!content) return '';

  // Decode HTML entities first
  const decoded = decodeHtmlEntities(content);
  const maxLength = 300;  // Increased from 150 for better context

  if (!query) {
    return decoded.substring(0, maxLength) + (decoded.length > maxLength ? '...' : '');
  }

  // Find first occurrence of any query term (case-insensitive)
  const terms = query.toLowerCase().split(/\s+/);
  const contentLower = decoded.toLowerCase();

  let earliestMatch = -1;
  for (const term of terms) {
    const index = contentLower.indexOf(term);
    if (index !== -1 && (earliestMatch === -1 || index < earliestMatch)) {
      earliestMatch = index;
    }
  }

  if (earliestMatch === -1) {
    // No match found, return first 300 chars
    return decoded.substring(0, maxLength) + (decoded.length > maxLength ? '...' : '');
  }

  // Extract ~300 chars centered on match
  const start = Math.max(0, earliestMatch - 100);
  const end = Math.min(decoded.length, start + maxLength);
  const snippet = decoded.substring(start, end);

  return (start > 0 ? '...' : '') + snippet + (end < decoded.length ? '...' : '');
}

/**
 * Search with smart recovery on insufficient results
 * Progressively broadens filters: date → tags → file_type
 * Preserves author/source (most specific to user intent)
 */
async function searchWithRecovery(
  query: string,
  limit: number,
  filters?: SearchFilters,
  sortPreference: string = 'relevance'
): Promise<SearchResponse> {

  let results = await hybridSearchWithFilters(query, limit, filters, sortPreference);

  // If < 50% of desired results, progressively broaden
  if (results.showing < limit * 0.5 && filters) {
    const originalFilters = { ...filters };

    // Step 1: Remove date filters (most restrictive)
    if (filters.after || filters.before) {
      console.log('[Recovery] Insufficient results, broadening date range...');
      delete filters.after;
      delete filters.before;
      results = await hybridSearchWithFilters(query, limit, filters, sortPreference);
    }

    // Step 2: Relax tag filter (if still insufficient)
    if (results.showing < limit * 0.5 && filters.tags) {
      console.log('[Recovery] Still insufficient, relaxing tag filter...');
      delete filters.tags;
      results = await hybridSearchWithFilters(query, limit, filters, sortPreference);
    }

    // Step 3: Expand file_type (if still insufficient)
    if (results.showing < limit * 0.5 && filters.file_type) {
      console.log('[Recovery] Expanding file type scope...');
      delete filters.file_type;
      results = await hybridSearchWithFilters(query, limit, filters, sortPreference);
    }

    // Keep author and source (most specific to user intent)
  }

  return results;
}

/**
 * Hybrid search with filters (when query provided)
 */
async function hybridSearchWithFilters(
  query: string,
  limit: number,
  filters?: SearchFilters,
  sortPreference: string = 'relevance'
): Promise<SearchResponse> {
  // People search pattern: add author to query for body text matching
  let searchQuery = query;
  if (filters?.author) {
    searchQuery = `${query} ${filters.author}`;
    console.log(`[Hybrid] Added author to query: "${searchQuery}"`);
  }

  // Generate query embedding for semantic search
  let queryEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      console.log('[Hybrid] Generating query embedding...');
      queryEmbedding = await generateEmbedding(searchQuery);
      console.log('[Hybrid] Embedding generated successfully');
    } catch (err) {
      console.warn('[Hybrid] Failed to generate query embedding, falling back to keyword-only:', err);
    }
  } else {
    console.log('[Hybrid] Embeddings not available, using keyword-only search');
  }

  // Call hybrid_search_chunked RPC
  // Note: RPC doesn't support filters directly, so we'll filter results afterward
  console.log(`[Hybrid] Calling hybrid_search_chunked RPC (match_count: ${limit * 3})`);
  const { data, error } = await supabase.rpc('hybrid_search_chunked', {
    query_text: searchQuery,
    query_embedding: queryEmbedding,
    p_user_id: USER_ID,
    match_count: limit * 3,  // Fetch more to account for filtering
    content_type: null
  });

  if (error) {
    console.error('[Hybrid] RPC error:', error);
    throw new Error(`Hybrid search RPC failed: ${error.message}`);
  }

  console.log(`[Hybrid] RPC returned ${data?.length || 0} results`);

  if (!data || data.length === 0) {
    return { results: [], total_count: 0, showing: 0 };
  }

  // Fetch file metadata for filtering, tags, and moc_memberships
  const filePaths = data.map((r: { path: string }) => r.path);
  let query_builder = supabase
    .from('files')
    .select('id, path, frontmatter, created_at, body, moc_memberships')
    .in('path', filePaths);

  // Apply filters to metadata fetch (pass query for AND/OR tag logic)
  query_builder = buildFilters(query_builder, filters, USER_ID, query);

  const { data: filesMetadata, error: metaError } = await query_builder;

  if (metaError) {
    throw new Error(`Failed to fetch metadata: ${metaError.message}`);
  }

  // Create map of filtered files
  const metadataMap = new Map(
    (filesMetadata || []).map((f: any) => [f.path, f])
  );

  // Filter and format results
  let results = data
    .filter((result: { path: string }) => metadataMap.has(result.path))
    .map((result: { path: string; snippet: string | null; score: number }) => {
      const metadata = metadataMap.get(result.path);

      return {
        id: metadata?.id || '',
        path: result.path,
        snippet: result.snippet || extractSnippet(metadata?.body || '', query),
        tags: metadata?.frontmatter?.tags || [],
        updated_at: metadata?.created_at || new Date().toISOString(),
        score: result.score,
        moc_memberships: metadata?.moc_memberships || []
      };
    });

  // Apply sorting (only if not using relevance)
  if (sortPreference === 'newest_first') {
    results.sort((a: SearchResult, b: SearchResult) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  } else if (sortPreference === 'oldest_first') {
    results.sort((a: SearchResult, b: SearchResult) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
  }
  // else: keep RRF relevance order from hybrid search

  // Extract unique tags from all results to check for MOCs
  const uniqueTags = new Set<string>();
  for (const result of results) {
    for (const tag of result.tags) {
      uniqueTags.add(tag);
    }
  }

  // Fetch MOC files for matching tags
  const mocs: MOCInfo[] = [];
  if (uniqueTags.size > 0) {
    const mocPaths = Array.from(uniqueTags).map(tag => `mocs/${tag}.md`);
    const { data: mocFiles, error: mocError } = await supabase
      .from('files')
      .select('path, body, frontmatter')
      .in('path', mocPaths)
      .eq('user_id', USER_ID);

    if (!mocError && mocFiles && mocFiles.length > 0) {
      for (const mocFile of mocFiles) {
        const topic = mocFile.path.replace('mocs/', '').replace('.md', '');
        mocs.push({
          topic,
          content: mocFile.body || '',
          item_count: mocFile.frontmatter?.item_count || 0
        });
      }
      console.log(`[Hybrid] Found ${mocs.length} MOC(s) matching result tags`);
    }
  }

  // Apply adaptive limit
  const totalCount = results.length;
  const adaptiveLimit = getAdaptiveLimit(totalCount);
  const displayResults = results.slice(0, adaptiveLimit);

  // Build response
  const response: SearchResponse = {
    results: displayResults,
    total_count: totalCount,
    showing: displayResults.length
  };

  // Add MOCs if any were found
  if (mocs.length > 0) {
    response.mocs = mocs;
  }

  // Add note if we're showing less than total
  if (totalCount > 50) {
    response.note = `Showing ${adaptiveLimit} of ${totalCount} results`;
  }

  return response;
}

/**
 * Filtered browse (no query, just filters)
 */
async function filteredBrowse(
  limit: number,
  filters?: SearchFilters,
  sortPreference: string = 'newest_first'
): Promise<SearchResponse> {
  const ascending = sortPreference === 'oldest_first';

  let query_builder = supabase
    .from('files')
    .select('id, path, frontmatter, created_at, body, moc_memberships')
    .order('created_at', { ascending })
    .limit(limit * 3);  // Fetch more for adaptive limiting

  // Apply filters (no query for browse mode)
  query_builder = buildFilters(query_builder, filters, USER_ID);

  const { data, error } = await query_builder;

  if (error) {
    throw new Error(`Filtered browse failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return { results: [], total_count: 0, showing: 0 };
  }

  // Format results (no scores for browse)
  const allResults = data.map((file: any) => ({
    id: file.id || '',
    path: file.path,
    snippet: extractSnippet(file.body || ''),
    tags: file.frontmatter?.tags || [],
    updated_at: file.created_at || new Date().toISOString(),
    score: undefined,
    moc_memberships: file.moc_memberships || []
  }));

  // Apply adaptive limit
  const totalCount = allResults.length;
  const adaptiveLimit = getAdaptiveLimit(totalCount);
  const displayResults = allResults.slice(0, adaptiveLimit);

  return {
    results: displayResults,
    total_count: totalCount,
    showing: displayResults.length,
    note: totalCount > 50 ? `Showing ${adaptiveLimit} of ${totalCount} results` : undefined
  };
}

/**
 * MCP tool handler for search_notes
 */
export async function searchNotesTool(args: {
  query?: string;
  limit?: number;
  file_type?: 'library' | 'learnings' | 'daily' | 'mocs';
  tags?: string[];
  author?: string;
  source?: 'youtube' | 'article' | 'pdf';
  after?: string;
  before?: string;
  date_range?: 'today' | 'yesterday' | 'this_week' | 'this_month';
  sort?: 'newest_first' | 'oldest_first' | 'relevance';
}): Promise<string> {
  const { query, limit, file_type, tags, author, source, after, before, date_range, sort } = args;
  const logs: string[] = [];

  try {
    logs.push(`[Search] Query: "${query || 'none'}", Limit: ${limit || 10}`);

    // Build filters
    const filters: SearchFilters = {};
    if (file_type) filters.file_type = file_type;
    if (tags && tags.length > 0) filters.tags = tags;
    if (author) filters.author = author;
    if (source) filters.source = source;
    if (after) filters.after = after;
    if (before) filters.before = before;
    if (date_range) filters.date_range = date_range;
    if (sort) filters.sort = sort;

    if (Object.keys(filters).length > 0) {
      logs.push(`[Search] Filters: ${JSON.stringify(filters)}`);
    }

    logs.push(`[Search] Embeddings available: ${isEmbeddingAvailable()}`);
    logs.push(`[Search] Mode: ${query ? 'hybrid search' : 'filtered browse'}`);

    const response = await searchNotes(query || null, limit, filters);

    logs.push(`[Search] Results: ${response.showing} shown (${response.total_count} total)`);

    if (response.total_count === 0) {
      const filterDesc = Object.keys(filters).length > 0 ? ' with applied filters' : '';
      const debugInfo = `\n\n--- Debug Info ---\n${logs.join('\n')}`;
      return query
        ? `No files found matching query: "${query}"${filterDesc}${debugInfo}`
        : `No files found${filterDesc}${debugInfo}`;
    }

    // Format MOCs if any
    let mocsSection = '';
    if (response.mocs && response.mocs.length > 0) {
      mocsSection = '\n=== Related MOCs ===\n\n';
      mocsSection += response.mocs.map(moc =>
        `MOC: ${moc.topic} (${moc.item_count} items)\n${moc.content.substring(0, 300)}...`
      ).join('\n\n');
      mocsSection += '\n\n=== Search Results ===\n\n';
    }

    // Format results as readable text
    const formattedResults = response.results.map((result, index) => {
      const tagsStr = result.tags.length > 0 ? ` [${result.tags.join(', ')}]` : '';
      const scoreStr = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : '';
      const mocStr = result.moc_memberships && result.moc_memberships.length > 0
        ? ` {MOCs: ${result.moc_memberships.join(', ')}}`
        : '';
      return `${index + 1}. ${result.path}${tagsStr}${mocStr}${scoreStr}
   Updated: ${new Date(result.updated_at).toLocaleDateString()}
   ${result.snippet}`;
    }).join('\n\n');

    const modeDesc = query ? 'search' : 'browse';
    const countDesc = `Found ${response.total_count} result${response.total_count === 1 ? '' : 's'}`;
    const noteSection = response.note ? `\n\n${response.note}` : '';
    const debugInfo = `\n\n--- Debug Info ---\n${logs.join('\n')}`;
    const readHint = `\n\nUse read_note tool with path to see full content of any result.`;
    return `${countDesc} (${modeDesc}):\n${mocsSection}\n${formattedResults}${noteSection}${readHint}${debugInfo}`;
  } catch (error) {
    logs.push(`[Search] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    const debugInfo = `\n--- Debug Info ---\n${logs.join('\n')}`;
    throw new Error(`Search failed${debugInfo}`);
  }
}

/**
 * Tool definition for MCP registration
 */
export const searchNotesToolDef = {
  name: 'search_notes',
  description: 'Search vault content using hybrid keyword + semantic search with advanced filters. Can search with query (hybrid keyword + semantic) or browse by filters only. People search: pass name to both author and query for BY + ABOUT results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (keywords or natural language). Optional - can filter without query for filtered browse.'
      },
      file_type: {
        type: 'string',
        enum: ['library', 'learnings', 'daily', 'mocs'],
        description: 'Filter by file location'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags (OR within array)'
      },
      author: {
        type: 'string',
        description: 'Filter by author name (matches author field OR guests array). For people search, also add to query.'
      },
      source: {
        type: 'string',
        enum: ['youtube', 'article', 'pdf'],
        description: 'Filter by source type (library files only)'
      },
      date_range: {
        type: 'string',
        enum: ['today', 'yesterday', 'this_week', 'this_month'],
        description: 'Convenient date presets: today (today only), yesterday (yesterday only), this_week (last 7 days), this_month (last 30 days)'
      },
      after: {
        type: 'string',
        description: 'Custom date filter after (YYYY-MM-DD, based on when YOU captured the content). Use date_range for convenient presets.'
      },
      before: {
        type: 'string',
        description: 'Custom date filter before (YYYY-MM-DD, based on when YOU captured the content). Use date_range for convenient presets.'
      },
      sort: {
        type: 'string',
        enum: ['newest_first', 'oldest_first', 'relevance'],
        description: 'Sort order: newest_first (default for browse), oldest_first, relevance (default for queries)'
      },
      limit: {
        type: 'number',
        description: 'Max results (1-20, default 10)'
      }
    },
    required: []
  }
};
