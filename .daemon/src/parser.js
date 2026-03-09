import matter from 'gray-matter';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';

export async function parseMarkdownFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');

    // gray-matter throws YAMLException for malformed frontmatter
    // Pass empty options {} to avoid caching issues (Pitfall 6)
    const parsed = matter(content, {});

    return {
      frontmatter: parsed.data,
      body: parsed.content,
      excerpt: parsed.excerpt,
      isEmpty: parsed.isEmpty
    };

  } catch (error) {
    // Check if it's a YAML parsing error
    // Check constructor name instead of instanceof (version compatibility)
    if (error.constructor.name === 'YAMLException') {
      logger.warn(
        { filePath, error: error.message },
        'Malformed YAML frontmatter, treating as plain markdown'
      );

      // Per SYNC-09: Handle malformed frontmatter gracefully
      // Fallback: treat entire file as body with no frontmatter
      const content = await readFile(filePath, 'utf8');
      return {
        frontmatter: {},
        body: content,
        excerpt: null,
        isEmpty: false,
        _malformed: true
      };
    }

    // Other errors (file read errors, etc.) should propagate
    throw error;
  }
}
