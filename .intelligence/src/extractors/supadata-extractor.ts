import { TranscriptSegment } from '../types/youtube.js';
import { formatSegmentsAsParagraphs } from '../utils/youtube.js';

export class SupadataExtractor {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.SUPADATA_API_KEY;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async getTranscript(videoId: string): Promise<{
    segments: TranscriptSegment[];
    fullText: string;
    language: string;
    metadata?: {
      title?: string;
      author?: string;
      duration?: number;
    };
  }> {
    if (!this.apiKey) {
      throw new Error('SUPADATA_API_KEY not configured');
    }

    // Fetch video metadata from Supadata
    let metadata;
    try {
      const metadataResponse = await fetch(
        `https://api.supadata.ai/v1/youtube/video?id=${videoId}`,
        {
          headers: { 'x-api-key': this.apiKey }
        }
      );

      if (metadataResponse.ok) {
        const metadataData = await metadataResponse.json();
        console.log('[Supadata] Metadata response:', JSON.stringify(metadataData).substring(0, 500));

        metadata = {
          title: metadataData.title,
          author: metadataData.author?.displayName,
          duration: metadataData.duration
        };
      } else {
        console.warn('[Supadata] Metadata fetch failed:', metadataResponse.status);
      }
    } catch (error: any) {
      console.warn('[Supadata] Metadata fetch error:', error.message);
    }

    // Fetch transcript
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}`,
      {
        headers: { 'x-api-key': this.apiKey }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Supadata] API error:', response.status, errorText);
      throw new Error(`Supadata API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[Supadata] Transcript response:', JSON.stringify(data).substring(0, 500));

    // Supadata API format: { lang: "en", content: [{ text, offset, duration }] }
    if (!data.content || !Array.isArray(data.content)) {
      throw new Error('Invalid Supadata API response: missing content array');
    }

    // Convert to our segment format (offset -> start in seconds)
    const segments: TranscriptSegment[] = data.content.map((s: any) => ({
      text: s.text,
      start: s.offset / 1000, // Convert ms to seconds
      duration: s.duration / 1000 // Convert ms to seconds
    }));

    const fullText = formatSegmentsAsParagraphs(segments);

    return {
      segments,
      fullText,
      language: data.lang || 'en',
      metadata
    };
  }
}
