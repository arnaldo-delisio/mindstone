import { GoogleGenerativeAI } from '@google/generative-ai';
import { summarizerLogger as logger } from '../utils/logger.js';

interface SummaryTier {
  name: string;
  minChars: number;
  maxChars: number;
  targetChars: number;
}

/**
 * Determine summarization tier based on content character length
 * Tiered compression: 3k->1k, 10k->2k, 30k->5k, 100k+->10k max
 */
function determineTier(chars: number): SummaryTier | null {
  if (chars < 3000) {
    // Too short to summarize
    return null;
  } else if (chars < 10000) {
    // 3k-10k chars: Compress to ~1k chars
    return { name: 'short', minChars: 3000, maxChars: 10000, targetChars: 1000 };
  } else if (chars < 30000) {
    // 10k-30k chars: Compress to ~2k chars
    return { name: 'medium', minChars: 10000, maxChars: 30000, targetChars: 2000 };
  } else if (chars < 100000) {
    // 30k-100k chars: Compress to ~5k chars
    return { name: 'long', minChars: 30000, maxChars: 100000, targetChars: 5000 };
  } else {
    // 100k+ chars: Compress to 10k chars max
    return { name: 'very-long', minChars: 100000, maxChars: Infinity, targetChars: 10000 };
  }
}

export interface SummaryResult {
  summary: string;
  tier: string;
  inputChars: number;
  outputChars: number;
  tokensUsed?: number;
}

/**
 * Generate smart-tier summary for content using Gemini 2.5 Flash-Lite
 * Returns null for content <3k chars (too short to summarize)
 *
 * Tiered compression:
 * - 3k-10k chars -> ~1k chars
 * - 10k-30k chars -> ~2k chars
 * - 30k-100k chars -> ~5k chars
 * - 100k+ chars -> 10k chars max
 */
export async function generateSummary(
  content: string,
  title: string,
  requestSource: 'mcp' | 'api' | 'queue' = 'queue'
): Promise<SummaryResult | null> {
  const inputChars = content.length;

  try {
    // Determine tier based on character length
    const tier = determineTier(inputChars);

    if (!tier) {
      logger.debug({ title, inputChars }, 'Content too short for summary');
      return null;
    }

    // Initialize Gemini client
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    logger.info(
      { title, inputChars, targetChars: tier.targetChars, tier: tier.name },
      'Generating summary with Gemini 2.5 Flash-Lite'
    );

    // Generate summary with structured prompt
    const prompt = `Summarize this content in approximately ${tier.targetChars} characters.

Focus on:
- Key insights and main arguments
- Actionable takeaways
- Technical details and specific examples

Be concise but comprehensive. Preserve important nuances.

Title: ${title}

Content:
${content}`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: Math.ceil(tier.targetChars / 4), // ~4 chars per token
      }
    });

    const summary = result.response.text();
    const outputChars = summary.length;

    // Extract token usage if available
    const tokensUsed = result.response.usageMetadata?.totalTokenCount;

    logger.info(
      { title, inputChars, outputChars, tier: tier.name, tokensUsed },
      'Summary generated successfully'
    );

    return {
      summary,
      tier: tier.name,
      inputChars,
      outputChars,
      tokensUsed
    };

  } catch (error) {
    logger.error({ error, title }, 'Summary generation failed');
    return null; // Fail gracefully
  }
}

/**
 * Check if summarization is available (GEMINI_API_KEY configured)
 */
export function isSummarizerAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
