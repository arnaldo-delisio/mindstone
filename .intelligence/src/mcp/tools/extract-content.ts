/**
 * extract_content Tool - Extract content from URLs and save to library
 *
 * Replaces synthesize_content's extraction stage with:
 * - Deduplication (returns cached result if exists)
 * - Library storage (library/youtube/, library/articles/, library/pdf/)
 * - Embedding generation for semantic search
 *
 * Supports YouTube videos, web articles, and PDFs.
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { YouTubeExtractor } from '../../extractors/youtube-extractor.js';
import { SupadataExtractor } from '../../extractors/supadata-extractor.js';
import { ArticleExtractor } from '../../extractors/article-extractor.js';
import { GeminiExtractor } from '../../extractors/gemini-extractor.js';
import { GitHubExtractor } from '../../extractors/github-extractor.js';
import { generateTags } from '../../processors/auto-tagger.js';
import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import { saveExtractedContent } from '../../utils/save-content.js';

interface ExtractResult {
  success: boolean;
  stage: 'cached' | 'extracted' | 'delegate' | 'choice_required' | 'queued';
  id?: string;
  path?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  chunks_status?: string;
  message: string;
  error?: string;
  choices?: {
    fast?: string;
    queue?: string;
  };
}

/**
 * Extract with Supadata API (fast path)
 */
async function extractWithSupadata(
  videoId: string,
  videoInfo: any
): Promise<ExtractResult> {
  console.log('[Supadata] Starting extraction for video:', videoId);
  const supadata = new SupadataExtractor();

  if (!supadata.isAvailable()) {
    console.log('[Supadata] API key not available');
    return {
      success: false,
      stage: 'choice_required',
      message: "Fast extraction not available. Please choose 'Save for later' instead.",
      choices: {
        queue: "Save for later - Queue for processing when laptop is online (~3-4 min)"
      }
    };
  }

  console.log('[Supadata] Calling API...');
  const transcript = await supadata.getTranscript(videoId);
  console.log('[Supadata] API call successful, got transcript');

  // Use Supadata metadata if available, fall back to videoInfo from YouTube
  const metadata = transcript.metadata || {};
  const title = metadata.title || videoInfo?.title;
  const author = metadata.author || videoInfo?.author;
  const duration = metadata.duration || videoInfo?.duration;

  console.log('[Supadata] Using metadata:', {
    title,
    author,
    duration,
    source: metadata.title ? 'supadata' : 'youtube'
  });

  // Generate slug from author-title
  const slug = generateYouTubeSlug(author, title, videoId);
  const libraryPath = `library/youtube/${slug}.md`;

  // Generate intelligent tags (topic-based only, format stored in 'type' field)
  const tags = await generateTags(transcript.fullText, title || 'YouTube Video');

  // Build frontmatter
  const frontmatter = {
    type: 'transcript',
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    source_title: title,
    source_author: author,
    source_duration_minutes: duration
      ? Math.floor(duration / 60)
      : undefined,
    video_id: videoId,
    extracted_at: new Date().toISOString(),
    extraction_method: 'supadata',
    tags
  };

  // Save to database using shared utility
  const saveResult = await saveExtractedContent({
    content: transcript.fullText,
    frontmatter,
    libraryPath,
    sourceType: 'youtube'
  });

  if (!saveResult.success) {
    return {
      success: false,
      stage: 'extracted',
      message: 'Extraction succeeded but file save failed',
      error: saveResult.error
    };
  }

  const preview = generatePreview(transcript.fullText);

  return {
    success: true,
    stage: 'extracted',
    id: saveResult.id,
    path: libraryPath,
    preview,
    metadata: frontmatter,
    chunks_status: 'pending',
    message: 'Content extracted. Semantic search processing in background.'
  };
}

/**
 * Create a queue file for local laptop processing
 */
async function createQueueFile(
  videoId: string,
  videoInfo: { title?: string; author?: string } | null
): Promise<string> {
  const queuePath = `queue/whisper/${videoId}.md`;

  const frontmatter = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: videoInfo?.title || 'Unknown',
    author: videoInfo?.author || 'Unknown',
    queued_at: new Date().toISOString(),
    status: 'pending'
  };

  const body = `# Queued for Processing

**Video:** ${videoInfo?.title || videoId}
**Queued:** ${new Date().toISOString()}

This video will be processed automatically when your laptop is online.
`;

  const content = matter.stringify(body, frontmatter);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const userId = USER_ID;

  await supabase.from('files').insert({
    path: queuePath,
    body: content,
    frontmatter,
    content_hash: contentHash,
    user_id: userId
  });

  return queuePath;
}

/**
 * Extract content from a URL or PDF file and save to library
 */
export async function extractContentTool(args: {
  url?: string;
  file?: string;
  fileName?: string;
  extraction_mode?: 'fast' | 'queue';
}): Promise<ExtractResult> {
  const { url, file, fileName } = args;

  // Validate input: must have either url or (file + fileName)
  if (!url && !file) {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid parameters',
      error: 'Must provide either url or file parameter'
    };
  }

  if (file && !fileName) {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid parameters',
      error: 'fileName is required when providing file'
    };
  }

  // Handle PDF file upload
  if (file && fileName) {
    return await handlePdfFile(file, fileName);
  }

  // Handle URL extraction
  if (!url || typeof url !== 'string') {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid URL parameter',
      error: 'URL must be a non-empty string'
    };
  }

  // Check if YouTube URL - capture video ID only (stop at & or ? or whitespace)
  const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?\s]+)/);

  if (youtubeMatch) {
    const videoId = youtubeMatch[1];

    // Note: libraryPath will be updated after we get video metadata
    // Check for existing extraction by video_id (deduplication)
    let existing: { id: string; path: string; frontmatter: Record<string, unknown>; body: string } | null = null;
    try {
      const { data } = await supabase
        .from('files')
        .select('id, path, frontmatter, body')
        .eq('user_id', USER_ID)
        .like('path', 'library/youtube/%')
        .ilike('frontmatter->>video_id', videoId)
        .single();
      existing = data;
    } catch {
      // No existing record — proceed with extraction
    }

    if (existing) {
      return {
        success: true,
        stage: 'cached',
        id: existing.id,
        path: existing.path,
        preview: existing.body?.slice(0, 5000),
        metadata: existing.frontmatter as Record<string, unknown>,
        message: 'Content already extracted. Use save_learning to save synthesis.'
      };
    }

    // Try captions first (free, works when available)
    try {
      const extractor = new YouTubeExtractor();
      const transcript = await extractor.getTranscript(videoId, { includeTimestamps: true });

      // Generate slug from author-title
      const slug = generateYouTubeSlug(transcript.author, transcript.title, videoId);
      const libraryPath = `library/youtube/${slug}.md`;

      // Generate intelligent tags (topic-based only, format stored in 'type' field)
      const tags = await generateTags(transcript.fullText, transcript.title || 'YouTube Video');

      // Build frontmatter per CONTEXT.md spec
      const frontmatter = {
        type: 'transcript',
        source_url: transcript.videoUrl,
        source_title: transcript.title,
        source_author: transcript.author,
        source_duration_minutes: transcript.duration
          ? Math.floor(transcript.duration / 60)
          : undefined,
        video_id: videoId,
        extracted_at: new Date().toISOString(),
        tags
      };

      // Level 1: Save file immediately with pending status (always instant return)
      const saveResult = await saveExtractedContent({
        content: transcript.fullText,
        frontmatter,
        libraryPath,
        sourceType: 'youtube'
      });

      if (!saveResult.success) {
        return {
          success: false,
          stage: 'extracted',
          message: 'Extraction succeeded but file save failed',
          error: saveResult.error
        };
      }

      // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
      // Always use Level 3 (Edge Function) for background processing
      // This prevents tool timeouts and memory issues
      let chunksStatus = 'pending';
      // Skip inline processing - embeddings will be ready in ~30s via Edge Function

      // Generate preview - smart sampling for long transcripts
      const preview = generatePreview(transcript.fullText);

      return {
        success: true,
        stage: 'extracted',
        id: saveResult.id,
        path: libraryPath,
        preview,
        metadata: frontmatter,
        chunks_status: chunksStatus,
        message: chunksStatus === 'complete'
          ? 'Content extracted with instant semantic search.'
          : 'Content extracted. Semantic search processing in background.'
      };

    } catch (error: any) {
      // Captions failed - check if it's the special CAPTIONS_UNAVAILABLE error
      if (error.code === 'CAPTIONS_UNAVAILABLE') {
        const videoInfo = error.videoInfo;

        // No mode specified? Ask user to choose
        if (!args.extraction_mode) {
          return {
            success: false,
            stage: 'choice_required',
            message: "This video's captions aren't directly available. How would you like to proceed?",
            metadata: {
              videoId,
              title: videoInfo?.title,
              author: videoInfo?.author
            },
            choices: {
              fast: "Extract now - Get transcript immediately (uses cloud processing)",
              queue: "Save for later - Queue for processing when laptop is online (~3-4 min)"
            }
          };
        }

        // Mode specified: execute chosen path
        if (args.extraction_mode === 'fast') {
          console.log('[Extract] Using fast mode (Supadata)');
          try {
            const result = await extractWithSupadata(videoId, videoInfo);
            console.log('[Extract] Fast mode completed successfully');
            return result;
          } catch (err) {
            console.error('[Extract] Fast mode failed:', err);
            throw err;
          }
        } else if (args.extraction_mode === 'queue') {
          console.log('[Extract] Using queue mode');

          const queuePath = await createQueueFile(videoId, videoInfo);
          return {
            success: true,
            stage: 'queued',
            path: queuePath,
            message: "Video queued for processing. The transcript will be ready in 3-4 minutes when your laptop is online."
          };
        }
      }

      // Other errors: throw
      return {
        success: false,
        stage: 'extracted',
        message: 'YouTube extraction failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // GitHub repositories: extract README and metadata
  const githubExtractor = new GitHubExtractor();
  const githubParsed = githubExtractor.parseGitHubUrl(url);

  if (githubParsed) {
    try {
      // Check for existing extraction (deduplication by repo full name)
      const { data: existing } = await supabase
        .from('files')
        .select('id, path, frontmatter, body')
        .eq('user_id', USER_ID)
        .like('path', 'library/repos/%')
        .ilike('frontmatter->>repo_full_name', `${githubParsed.owner}/${githubParsed.repo}`)
        .single();

      if (existing) {
        return {
          success: true,
          stage: 'cached',
          id: (existing as any).id,
          path: existing.path,
          preview: existing.body?.slice(0, 5000),
          metadata: existing.frontmatter as Record<string, unknown>,
          message: 'Repository already extracted. Use save_learning to save synthesis.'
        };
      }

      // Extract repo info
      const repo = await githubExtractor.extract(url);
      const slug = githubExtractor.generateSlug(repo.owner, repo.name);
      const libraryPath = `library/repos/${slug}.md`;

      // Format as markdown
      const { content, frontmatter: repoFrontmatter } = githubExtractor.formatAsMarkdown(repo, url);

      // Generate intelligent tags from README and description
      const taggingText = `${repo.description || ''}\n\n${repo.readme}`.slice(0, 10000);
      const tags = await generateTags(taggingText, `${repo.owner}/${repo.name}`);

      // Add tags to frontmatter
      const frontmatter = {
        ...repoFrontmatter,
        tags
      };

      // Save file
      const saveResult = await saveExtractedContent({
        content,
        frontmatter,
        libraryPath,
        sourceType: 'repository'
      });

      if (!saveResult.success) {
        return {
          success: false,
          stage: 'extracted',
          message: 'Extraction succeeded but file save failed',
          error: saveResult.error
        };
      }

      // Generate preview
      const preview = content.slice(0, 5000);

      return {
        success: true,
        stage: 'extracted',
        id: saveResult.id,
        path: libraryPath,
        preview,
        metadata: frontmatter,
        chunks_status: 'pending',
        message: `Repository extracted: ${repo.owner}/${repo.name}`
      };
    } catch (error) {
      return {
        success: false,
        stage: 'extracted',
        message: 'GitHub extraction failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Non-YouTube, non-GitHub URLs: extract as article
  try {
    const extractor = new ArticleExtractor();
    const article = await extractor.extractFromUrl(url);

    // Generate slug for library path
    const slug = extractor.generateSlug(url);
    const libraryPath = `library/articles/${slug}.md`;

    // Check for existing extraction (deduplication)
    const { data: existing } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .eq('path', libraryPath)
      .single();

    if (existing) {
      return {
        success: true,
        stage: 'cached',
        id: (existing as any).id,
        path: existing.path,
        preview: existing.body?.slice(0, 5000),
        metadata: existing.frontmatter as Record<string, unknown>,
        message: 'Article already extracted. Use save_learning to save synthesis.'
      };
    }

    // Generate intelligent tags (topic-based only, format stored in 'type' field)
    const tags = await generateTags(article.content, article.title);

    // Build frontmatter per CONTEXT.md spec
    const frontmatter = {
      type: 'article',
      title: article.title,
      source_url: article.originalUrl,
      source_author: article.author,
      source_site: article.siteName,
      published_date: article.publishedDate,
      word_count: article.wordCount,
      excerpt: article.excerpt,
      extracted_at: new Date().toISOString(),
      tags
    };

    // Level 1: Save file immediately with pending status (always instant return)
    const saveResult = await saveExtractedContent({
      content: article.content,
      frontmatter,
      libraryPath,
      sourceType: 'article'
    });

    if (!saveResult.success) {
      return {
        success: false,
        stage: 'extracted',
        message: 'Extraction succeeded but file save failed',
        error: saveResult.error
      };
    }

    // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
    // Always use Level 3 (Edge Function) for background processing
    let chunksStatus = 'pending';
    // Skip inline processing - embeddings will be ready in ~30s via Edge Function

    // Generate preview
    const preview = generatePreview(article.content);

    return {
      success: true,
      stage: 'extracted',
      id: saveResult.id,
      path: libraryPath,
      preview,
      metadata: frontmatter,
      chunks_status: chunksStatus,
      message: chunksStatus === 'complete'
        ? 'Article extracted with instant semantic search.'
        : 'Article extracted. Semantic search processing in background.'
    };

  } catch (error) {
    return {
      success: false,
      stage: 'extracted',
      message: 'Article extraction failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Handle PDF file extraction
 */
async function handlePdfFile(
  base64Content: string,
  fileName: string
): Promise<ExtractResult> {
  // Generate slug from filename for library path
  const slug = fileName
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const libraryPath = `library/pdf/${slug}.md`;

  // Check for existing extraction (deduplication)
  const { data: existing } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .eq('path', libraryPath)
    .single();

  if (existing) {
    return {
      success: true,
      stage: 'cached',
      id: (existing as any).id,
      path: existing.path,
      preview: existing.body?.slice(0, 5000),
      metadata: existing.frontmatter as Record<string, unknown>,
      message: 'PDF already extracted. Use save_learning to save synthesis.'
    };
  }

  // Extract with GeminiExtractor
  let tempPath: string | null = null;
  try {
    // Create temp directory and write PDF
    const tempDir = mkdtempSync(join(tmpdir(), 'pdf-extract-'));
    tempPath = join(tempDir, fileName);
    const pdfBuffer = Buffer.from(base64Content, 'base64');
    writeFileSync(tempPath, pdfBuffer);

    // Extract content
    const extractor = new GeminiExtractor();
    const result = await extractor.extractFromFile(tempPath, fileName);

    // Generate intelligent tags (topic-based only, format stored in 'type' field)
    const tags = await generateTags(result.content, result.title);

    // Build frontmatter per CONTEXT.md spec
    const frontmatter = {
      type: 'pdf',
      title: result.title,
      author: result.author,
      published_date: result.publishedDate,
      page_count: result.pageCount,
      file_size_bytes: result.fileSize,
      word_count: result.wordCount,
      original_filename: result.originalFileName,
      extracted_at: new Date().toISOString(),
      tags
    };

    // Level 1: Save file immediately with pending status (always instant return)
    const saveResult = await saveExtractedContent({
      content: result.content,
      frontmatter,
      libraryPath,
      sourceType: 'pdf'
    });

    if (!saveResult.success) {
      return {
        success: false,
        stage: 'extracted',
        message: 'Extraction succeeded but file save failed',
        error: saveResult.error
      };
    }

    // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
    // Always use Level 3 (Edge Function) for background processing
    let chunksStatus = 'pending';
    // Skip inline processing - embeddings will be ready in ~30s via Edge Function

    // Generate preview
    const preview = generatePreview(result.content);

    return {
      success: true,
      stage: 'extracted',
      id: saveResult.id,
      path: libraryPath,
      preview,
      metadata: frontmatter,
      chunks_status: chunksStatus,
      message: chunksStatus === 'complete'
        ? 'PDF extracted with instant semantic search.'
        : 'PDF extracted. Semantic search processing in background.'
    };

  } catch (error) {
    return {
      success: false,
      stage: 'extracted',
      message: 'PDF extraction failed',
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Clean up temp file
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Generate slug for YouTube video: author-title format
 * Example: "healthygamergg-why-you-should-stop-watching-youtube"
 */
function generateYouTubeSlug(author?: string, title?: string, videoId?: string): string {
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
    .replace(/[^a-z0-9-]/g, '-')  // Only alphanumeric + dash
    .replace(/-+/g, '-')          // Collapse multiple dashes
    .replace(/^-|-$/g, '')        // Trim dashes
    .slice(0, 80);                // Max 80 chars for readability

  return slug || videoId || `video-${Date.now()}`;
}

/**
 * Generate smart preview for transcript
 * Samples intro + middle + end for context
 */
function generatePreview(text: string, maxLength: number = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Sample: first 2000 chars + middle 1500 chars + last 1500 chars
  const intro = text.slice(0, 2000);
  const middleStart = Math.floor(text.length / 2) - 750;
  const middle = text.slice(middleStart, middleStart + 1500);
  const outro = text.slice(-1500);

  return `${intro}\n\n[... content continues ...]\n\n${middle}\n\n[... content continues ...]\n\n${outro}`;
}

/**
 * Tool definition for MCP registration
 */
export const extractContentToolDef = {
  name: 'extract_content',
  description: 'Extract content from a URL (YouTube video, web article) or PDF file and save to library. Returns preview and path. Handles deduplication automatically. Provide either "url" OR both "file" and "fileName" parameters.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract content from (YouTube video or web article URL). Use this parameter OR the file+fileName parameters.'
      },
      file: {
        type: 'string',
        description: 'Base64-encoded PDF file content (alternative to url). Must be used with fileName parameter.'
      },
      fileName: {
        type: 'string',
        description: 'Original filename (required when file parameter is provided)'
      },
      extraction_mode: {
        type: 'string',
        enum: ['fast', 'queue'],
        description: 'OPTIONAL - Only provide on second call after tool returns choice_required status. Leave empty on first call to let the tool detect availability and present options. When provided: "fast" = immediate cloud extraction, "queue" = laptop processing when online (3-4 min).'
      }
    }
  }
};
