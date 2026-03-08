/**
 * Shared save logic for extracted content
 * Used by both MCP extract_content tool and REST /api/upload endpoint
 */

import { createHash } from 'crypto';
import { supabase } from '../services/supabase.js';
import { USER_ID } from '../config.js';

export interface SaveContentParams {
  content: string;
  frontmatter: Record<string, any>;
  libraryPath: string;
  sourceType: 'youtube' | 'article' | 'pdf' | 'epub' | 'docx' | 'repository';
}

export interface SaveContentResult {
  success: boolean;
  id?: string;
  path?: string;
  preview?: string;
  error?: string;
}

/**
 * Save extracted content to Supabase files table
 * Triggers background intelligence and embeddings processing
 */
export async function saveExtractedContent(
  params: SaveContentParams
): Promise<SaveContentResult> {
  const { content, frontmatter, libraryPath, sourceType } = params;

  // Build content hash for deduplication
  const contentHash = createHash('sha256')
    .update(content)
    .digest('hex');

  try {
    // Save to Supabase with proper status flags for background processing
    const { data: fileData, error: upsertError } = await supabase
      .from('files')
      .upsert({
        path: libraryPath,
        body: content,
        frontmatter,
        embedding: null,
        content_hash: contentHash,
        user_id: USER_ID,
        chunks_status: 'pending',           // Triggers embeddings queue
        intelligence_status: 'pending'       // Triggers intelligence queue (tagging, summary)
      }, { onConflict: 'user_id,path' })
      .select('id')
      .single();

    if (upsertError || !fileData) {
      return {
        success: false,
        error: upsertError?.message || 'No file data returned from database'
      };
    }

    // Generate preview (first 5000 chars)
    const preview = content.slice(0, 5000);

    return {
      success: true,
      id: fileData.id,
      path: libraryPath,
      preview
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to save content'
    };
  }
}

/**
 * Generate library path from content metadata
 */
export function generateLibraryPath(
  sourceType: 'youtube' | 'article' | 'pdf' | 'epub' | 'docx' | 'repository',
  slug: string
): string {
  const directory = sourceType === 'youtube' ? 'youtube' :
                   sourceType === 'article' ? 'articles' :
                   sourceType === 'repository' ? 'repos' :
                   'books';

  return `library/${directory}/${slug}.md`;
}

/**
 * Create slug from title (used for PDFs, EPUBs, DOCX)
 */
export function createSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Remove consecutive hyphens
    .substring(0, 100);          // Limit length
}

/**
 * Generate slug for YouTube video (MATCHES MCP IMPLEMENTATION)
 * Format: author-title
 * Example: "healthygamergg-why-you-should-stop-watching-youtube"
 */
export function createYouTubeSlug(author?: string, title?: string, videoId?: string): string {
  // Fallback to videoId if author/title missing
  if (!author && !title) {
    return videoId || `video-${Date.now()}`;
  }

  // Build slug from author-title
  const parts: string[] = [];
  if (author) parts.push(author);
  if (title) parts.push(title);

  const slug = parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // Only alphanumeric + dash (MCP standard)
    .replace(/-+/g, '-')          // Collapse multiple dashes
    .replace(/^-|-$/g, '')        // Trim dashes
    .slice(0, 80);                // Max 80 chars

  return slug || videoId || `video-${Date.now()}`;
}

/**
 * Generate slug from article URL (MATCHES MCP IMPLEMENTATION)
 * Uses domain + path component
 */
export function createArticleSlug(url: string): string {
  try {
    const urlObj = new URL(url);
    let slug = urlObj.hostname.replace(/^www\./, '');

    // Add path component if meaningful
    const path = urlObj.pathname.replace(/^\/+|\/+$/g, '');
    if (path && path !== 'index.html' && path !== 'index.php') {
      const pathPart = path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') // Remove extension
        ?.slice(0, 30); // Limit length

      if (pathPart) {
        slug += '-' + pathPart;
      }
    }

    // Clean slug: only alphanumeric + dash, max 50 chars (MCP standard)
    return slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

  } catch {
    return `article-${Date.now()}`;
  }
}
