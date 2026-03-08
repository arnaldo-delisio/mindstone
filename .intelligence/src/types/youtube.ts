// YouTube Transcript Types

export interface TranscriptSegment {
  text: string;
  start: number;  // Start time in seconds
  duration: number;  // Duration in seconds
}

export interface YouTubeTranscript {
  videoId: string;
  videoUrl: string;
  title?: string;
  author?: string;
  description?: string;
  segments: TranscriptSegment[];
  fullText: string;  // Combined text of all segments
  language?: string;
  duration?: number;  // Total video duration in seconds
}

export interface TranscriptOptions {
  language?: string;  // Preferred language code (e.g., 'en', 'it')
  preserveFormatting?: boolean;  // Keep line breaks from captions
  includeTimestamps?: boolean;  // Include timestamps in full text
  useWhisperFallback?: boolean;  // Use Whisper API if captions unavailable
}

export interface VideoInfo {
  videoId: string;
  title: string;
  author: string;
  duration: number;  // Duration in seconds
  description?: string;
  thumbnailUrl?: string;
}
