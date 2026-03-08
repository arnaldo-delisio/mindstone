/**
 * Article Extractor - Extract content from web articles
 *
 * Uses Mozilla Readability + jsdom for clean article extraction
 * Handles paywalls via reader mode parsing (best-effort)
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface ArticleExtractionResult {
  title: string;
  content: string;
  author?: string;
  publishedDate?: string;
  wordCount: number;
  sourceType: 'article';
  originalUrl: string;
  siteName?: string;
  excerpt?: string;
}

export class ArticleExtractor {
  /**
   * Extract article content from a URL
   */
  async extractFromUrl(url: string): Promise<ArticleExtractionResult> {
    // Fetch HTML with browser-like user agent
    const html = await this.fetchHtml(url);

    // Parse with jsdom
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Apply readability
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      throw new Error('Failed to extract article content - page may not contain readable content');
    }

    // Convert HTML to markdown-like plain text
    const content = this.htmlToMarkdown(article.content || '');

    // Calculate word count
    const wordCount = content.split(/\s+/).length;

    // Extract metadata
    const metadata = this.extractMetadata(document, article);

    return {
      title: article.title || this.extractTitleFallback(document),
      content,
      author: article.byline || metadata.author,
      publishedDate: metadata.publishedDate,
      wordCount,
      sourceType: 'article',
      originalUrl: url,
      siteName: article.siteName || metadata.siteName,
      excerpt: article.excerpt || undefined
    };
  }

  /**
   * Fetch HTML from URL with browser-like headers
   */
  private async fetchHtml(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      throw new Error(
        `Failed to fetch article from ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Convert HTML to clean markdown-like text
   */
  private htmlToMarkdown(html: string): string {
    // Create a temporary DOM to parse HTML
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const body = document.body;

    // Process elements recursively
    return this.processNode(body).trim();
  }

  /**
   * Process DOM node recursively to extract text
   */
  private processNode(node: Node): string {
    if (node.nodeType === 3) { // Text node
      return node.textContent || '';
    }

    if (node.nodeType !== 1) { // Not an element node
      return '';
    }

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();

    // Skip script and style tags
    if (tagName === 'script' || tagName === 'style') {
      return '';
    }

    // Process children
    let content = '';
    for (const child of Array.from(element.childNodes)) {
      content += this.processNode(child);
    }

    // Add appropriate formatting based on tag
    switch (tagName) {
      case 'p':
      case 'div':
        return `${content}\n\n`;

      case 'br':
        return '\n';

      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        const level = parseInt(tagName[1]);
        return `${'#'.repeat(level)} ${content}\n\n`;

      case 'ul':
      case 'ol':
        return `${content}\n`;

      case 'li':
        return `- ${content}\n`;

      case 'blockquote':
        return `> ${content}\n\n`;

      case 'code':
        return `\`${content}\``;

      case 'pre':
        return `\`\`\`\n${content}\n\`\`\`\n\n`;

      case 'strong':
      case 'b':
        return `**${content}**`;

      case 'em':
      case 'i':
        return `*${content}*`;

      case 'a':
        const href = element.getAttribute('href');
        return href ? `[${content}](${href})` : content;

      default:
        return content;
    }
  }

  /**
   * Extract metadata from document and readability result
   */
  private extractMetadata(document: Document, article: any): {
    author?: string;
    publishedDate?: string;
    siteName?: string;
  } {
    const metadata: {
      author?: string;
      publishedDate?: string;
      siteName?: string;
    } = {};

    // Try to extract author from meta tags
    const authorMeta =
      document.querySelector('meta[name="author"]') ||
      document.querySelector('meta[property="article:author"]') ||
      document.querySelector('meta[property="og:author"]');

    if (authorMeta) {
      metadata.author = authorMeta.getAttribute('content') || undefined;
    }

    // Try to extract published date
    const dateMeta =
      document.querySelector('meta[property="article:published_time"]') ||
      document.querySelector('meta[name="publication_date"]') ||
      document.querySelector('meta[name="date"]');

    if (dateMeta) {
      metadata.publishedDate = dateMeta.getAttribute('content') || undefined;
    }

    // Try to extract site name
    const siteNameMeta =
      document.querySelector('meta[property="og:site_name"]') ||
      document.querySelector('meta[name="application-name"]');

    if (siteNameMeta) {
      metadata.siteName = siteNameMeta.getAttribute('content') || undefined;
    }

    return metadata;
  }

  /**
   * Extract title from document as fallback
   */
  private extractTitleFallback(document: Document): string {
    // Try meta tags first
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const content = ogTitle.getAttribute('content');
      if (content) return content;
    }

    // Fall back to document title
    return document.title || 'Untitled Article';
  }

  /**
   * Generate slug from URL for filename
   */
  generateSlug(url: string): string {
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

      // Clean slug: only alphanumeric, dash, max 50 chars
      return slug
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50);
    } catch {
      // Invalid URL, create hash-based slug
      return `article-${Date.now()}`;
    }
  }
}
