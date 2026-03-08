// YouTube Transcript Extractor
import { YoutubeTranscript } from 'youtube-transcript-plus';
import type {
  YouTubeTranscript,
  TranscriptSegment,
  TranscriptOptions
} from '../types/youtube.js';
import { extractVideoId, getVideoInfo, scrapeVideoInfo, formatTimestamp, formatSegmentsAsParagraphs } from '../utils/youtube.js';
import { decodeHtmlEntities } from '../utils/html-decode.js';

const DEFAULT_LANGUAGES = ['en', 'en-US', 'en-GB'];

export class YouTubeExtractor {

  /**
   * Get transcript for a YouTube video
   */
  async getTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions = {}
  ): Promise<YouTubeTranscript> {
    const videoId = extractVideoId(videoIdOrUrl);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Get video info - try ytdl-core first, then scraping fallback
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(videoId);
    } catch (error: any) {
      // ytdl-core failed, try scraping fallback
      try {
        videoInfo = await scrapeVideoInfo(videoId);
      } catch (scrapeError: any) {
        // Both methods failed, continue without video info
        videoInfo = null;
      }
    }

    // Try fetching transcript from captions
    console.log(`[YouTube] Attempting caption fetch for video: ${videoId}`);
    let transcript;
    try {
      transcript = await this.fetchFromCaptions(videoId, options);
      console.log(`[YouTube] Captions fetched successfully`);
    } catch (error: any) {
      console.error(`[YouTube] Caption fetch failed: ${error.message}`);

      // Throw special error with code for extract_content to handle
      const captionsError = new Error(
        error.message || 'Captions not available for this video'
      );
      (captionsError as any).code = 'CAPTIONS_UNAVAILABLE';
      (captionsError as any).videoId = videoId;
      (captionsError as any).videoInfo = videoInfo;
      throw captionsError;
    }

    return {
      videoId,
      videoUrl,
      title: videoInfo?.title,
      author: videoInfo?.author,
      description: videoInfo?.description || undefined,
      duration: videoInfo?.duration,
      ...transcript,
    };
  }

  /**
   * Fetch transcript from YouTube captions
   */
  private async fetchFromCaptions(
    videoId: string,
    options: TranscriptOptions
  ): Promise<Pick<YouTubeTranscript, 'segments' | 'fullText' | 'language'>> {
    const languages = options.language
      ? [options.language, ...DEFAULT_LANGUAGES]
      : DEFAULT_LANGUAGES;

    console.log(`[YouTube] Trying caption languages: ${languages.join(', ')}`);

    // Try each language
    let lastError: Error | null = null;
    for (const lang of languages) {
      try {
        console.log(`[YouTube] Fetching captions for lang: ${lang}`);
        const transcriptData = await YoutubeTranscript.fetchTranscript(videoId, {
          lang,
        });

        console.log(`[YouTube] Got ${transcriptData.length} caption segments for lang: ${lang}`);

        // Convert to our format and decode HTML entities
        const segments: TranscriptSegment[] = transcriptData.map((item: any) => ({
          text: decodeHtmlEntities(item.text),
          start: item.offset,  // Already in seconds
          duration: item.duration,  // Already in seconds
        }));

        const fullText = this.formatFullText(segments, options);

        return {
          segments,
          fullText,
          language: lang,
        };
      } catch (error: any) {
        console.error(`[YouTube] Caption fetch failed for lang ${lang}: ${error.message}`);
        lastError = error;
        continue;  // Try next language
      }
    }

    throw lastError || new Error('No captions available for this video');
  }

  /**
   * Format segments into full text
   */
  private formatFullText(segments: TranscriptSegment[], options: TranscriptOptions): string {
    if (options.includeTimestamps) {
      return formatSegmentsAsParagraphs(segments);
    }

    if (options.preserveFormatting) {
      return segments.map(seg => seg.text).join('\n');
    }

    // Default: combine into flat text
    return segments.map(seg => seg.text).join(' ');
  }
}
