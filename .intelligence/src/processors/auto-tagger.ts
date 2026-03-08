import { GoogleGenerativeAI } from '@google/generative-ai';
import { autoTaggerLogger as logger } from '../utils/logger.js';

// Hardcoded broad categories (no taxonomy file needed)
const BROAD_CATEGORIES = [
  'health', 'business', 'productivity', 'learning', 'technology',
  'ai', 'mindset', 'systems', 'tools', 'personal'
];

/**
 * Determine tag count range based on content length
 * Short content: fewer tags, long content: more tags
 */
function getTagCountRange(contentLength: number): { min: number; max: number; description: string } {
  const estimatedTokens = Math.ceil(contentLength / 4); // Rough estimate: ~4 chars per token

  if (estimatedTokens < 1000) {
    return { min: 5, max: 7, description: '5-7' };
  } else if (estimatedTokens < 5000) {
    return { min: 8, max: 10, description: '8-10' };
  } else {
    return { min: 10, max: 15, description: '10-15' };
  }
}

/**
 * Generate tags for content using Gemini 2.5 Flash-Lite
 *
 * Features:
 * - Dynamic tag count based on content length
 * - 2-3 broad categories + 7-8 specific tags
 * - JSON response for reliable parsing
 * - Temperature 0.3 for consistency
 *
 * Returns empty array on error (graceful degradation)
 */
export async function generateTags(
  content: string,
  title: string
): Promise<string[]> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      logger.warn('GEMINI_API_KEY not configured, skipping tagging');
      return [];
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    // Dynamic tag count based on content length
    const tagRange = getTagCountRange(content.length);

    const prompt = `Analyze this content and generate ${tagRange.description} relevant tags.

TAG STRUCTURE:
- Include 2-3 BROAD categories from this list: ${BROAD_CATEGORIES.join(', ')}
- Add specific tags (lowercase, kebab-case) for the remaining slots: e.g., sleep-optimization, content-strategy, b2b-saas, neuroscience, habit-stacking

RULES:
- Total tags: ${tagRange.min} to ${tagRange.max}
- Broad categories first, then specific tags
- Specific tags should be descriptive and useful for discovery
- All tags lowercase, use hyphens for multi-word tags

Content:
Title: ${title}
${content.substring(0, 3000)}

Return JSON only: { "tags": ["broad1", "broad2", "specific1", "specific2", ...] }`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json'
      }
    });

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);
    const tags = parsed.tags || [];

    logger.debug({ tags, title, tagCount: tags.length }, 'Generated tags');
    return tags;

  } catch (error) {
    logger.error({ error, title }, 'Tag generation failed');
    return []; // Return empty on error (file will still be marked complete)
  }
}

/**
 * Check if Gemini API is available for tag generation
 */
export function isTaggingAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
