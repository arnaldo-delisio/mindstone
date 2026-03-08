/**
 * Extractor Factory
 *
 * Detects content type from URL and returns appropriate extractor
 */

import { YouTubeExtractor } from './youtube-extractor.js';
import { ArticleExtractor } from './article-extractor.js';
import { GeminiExtractor } from './gemini-extractor.js';
import { SupadataExtractor } from './supadata-extractor.js';
import { GitHubExtractor } from './github-extractor.js';

export type ExtractorType = 'youtube' | 'article' | 'pdf' | 'github';

export interface BaseExtractor {
  isAvailable(): boolean;
  extract(...args: any[]): Promise<any>;
}

/**
 * Detect content type from URL
 */
export function detectContentType(url: string): ExtractorType {
  // YouTube URLs
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  }

  // GitHub repository URLs
  if (url.includes('github.com/')) {
    const githubExtractor = new GitHubExtractor();
    if (githubExtractor.parseGitHubUrl(url)) {
      return 'github';
    }
  }

  // PDF files
  if (url.toLowerCase().endsWith('.pdf')) {
    return 'pdf';
  }

  // Default to article for all other web URLs
  return 'article';
}

/**
 * Factory function to get appropriate extractor for a URL
 */
export function extractorFactory(url: string): {
  type: ExtractorType;
  extractor: BaseExtractor;
} {
  const type = detectContentType(url);

  switch (type) {
    case 'youtube':
      return {
        type,
        extractor: {
          isAvailable: () => true, // YouTube extractor always available
          extract: async (url: string, options?: any) => {
            const youtubeExtractor = new YouTubeExtractor();
            return await youtubeExtractor.getTranscript(url, options || {});
          }
        }
      };

    case 'github':
      return {
        type,
        extractor: {
          isAvailable: () => true, // GitHub extractor always available (uses public API)
          extract: async (url: string) => {
            const githubExtractor = new GitHubExtractor();
            return await githubExtractor.extract(url);
          }
        }
      };

    case 'article':
      return {
        type,
        extractor: {
          isAvailable: () => true, // Article extractor always available
          extract: async (url: string) => {
            const articleExtractor = new ArticleExtractor();
            return await articleExtractor.extractFromUrl(url);
          }
        }
      };

    case 'pdf':
      return {
        type,
        extractor: {
          isAvailable: () => new GeminiExtractor().isAvailable(),
          extract: async (filePath: string, fileName: string) => {
            const geminiExtractor = new GeminiExtractor();
            return await geminiExtractor.extractFromFile(filePath, fileName);
          }
        }
      };

    default:
      throw new Error(`Unsupported content type for URL: ${url}`);
  }
}

// Export extractors for direct use if needed
export { YouTubeExtractor } from './youtube-extractor.js';
export { ArticleExtractor } from './article-extractor.js';
export { GeminiExtractor } from './gemini-extractor.js';
export { SupadataExtractor } from './supadata-extractor.js';
export { GitHubExtractor } from './github-extractor.js';
export { extractFromEpub, formatEpubAsMarkdown } from './epub-extractor.js';
