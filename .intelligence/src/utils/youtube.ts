// YouTube utility functions
import ytdl from '@distube/ytdl-core';
import YTDlpWrap from 'yt-dlp-wrap';
import { readdir, unlink, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import type { Readable } from 'stream';

/**
 * Clean up ytdl-core debug files from /tmp
 */
export async function cleanupDebugFiles(): Promise<void> {
  try {
    const files = await readdir('/tmp');
    const debugFiles = files.filter(f => f.endsWith('-player-script.js'));
    await Promise.all(debugFiles.map(f => unlink(`/tmp/${f}`).catch(() => {})));
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Extract video ID from YouTube URL or return if already an ID
 */
export function extractVideoId(urlOrId: string): string {
  // Strip query parameters if present (e.g., ?si=xxx from share links)
  const cleanedInput = urlOrId.split('?')[0];

  // If already a video ID (11 characters, alphanumeric)
  if (/^[a-zA-Z0-9_-]{11}$/.test(cleanedInput)) {
    return cleanedInput;
  }

  // Try to extract from URL (use original input for full URL parsing)
  try {
    const videoId = ytdl.getVideoID(urlOrId);
    return videoId;
  } catch (error) {
    throw new Error(`Invalid YouTube URL or video ID: ${urlOrId}`);
  }
}

/**
 * Get basic video information using ytdl-core
 */
export async function getVideoInfo(videoIdOrUrl: string) {
  const videoId = extractVideoId(videoIdOrUrl);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;

    return {
      videoId,
      title: details.title,
      author: details.author.name,
      duration: parseInt(details.lengthSeconds, 10),
      description: details.description,
      thumbnailUrl: details.thumbnails[details.thumbnails.length - 1]?.url,
    };
  } catch (error: any) {
    throw new Error(`Failed to fetch video info: ${error.message}`);
  } finally {
    // Clean up ytdl-core debug files
    cleanupDebugFiles();
  }
}

/**
 * Format duration from seconds to HH:MM:SS
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format timestamp from seconds to HH:MM:SS (always includes hours for consistency)
 */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format transcript segments as timestamped paragraphs.
 * Groups segments into ~45-second blocks, prefixing each paragraph with [HH:MM:SS].
 * Used for clip extraction — timestamps mark the start of each paragraph.
 */
export function formatSegmentsAsParagraphs(
  segments: Array<{ text: string; start: number }>
): string {
  if (segments.length === 0) return '';

  const PARAGRAPH_DURATION = 45; // seconds per paragraph

  const paragraphs: string[] = [];
  let currentTexts: string[] = [];
  let paragraphStart = segments[0].start;
  let paragraphEnd = paragraphStart + PARAGRAPH_DURATION;

  for (const seg of segments) {
    if (seg.start >= paragraphEnd && currentTexts.length > 0) {
      paragraphs.push(`[${formatTimestamp(paragraphStart)}] ${currentTexts.join(' ')}`);
      currentTexts = [seg.text];
      paragraphStart = seg.start;
      paragraphEnd = seg.start + PARAGRAPH_DURATION;
    } else {
      currentTexts.push(seg.text);
    }
  }

  if (currentTexts.length > 0) {
    paragraphs.push(`[${formatTimestamp(paragraphStart)}] ${currentTexts.join(' ')}`);
  }

  return paragraphs.join('\n\n');
}

/**
 * Scrape video metadata from YouTube page (fallback method)
 */
export async function scrapeVideoInfo(videoIdOrUrl: string) {
  const videoId = extractVideoId(videoIdOrUrl);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Extract player response for video details
    let title: string | undefined;
    let author: string | undefined;
    let duration: number | undefined;
    let description: string | undefined;

    // Method 1: Try ytInitialPlayerResponse first (most reliable)
    const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s);
    if (playerResponseMatch) {
      try {
        const playerData = JSON.parse(playerResponseMatch[1]);
        title = playerData.videoDetails?.title;
        author = playerData.videoDetails?.author;
        duration = parseInt(playerData.videoDetails?.lengthSeconds, 10);
        description = playerData.videoDetails?.shortDescription;
      } catch (e) {
        // Parsing failed, try other methods
      }
    }

    // Method 2: Fallback to meta tags if player response didn't work
    if (!title || !author) {
      const titleMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/);
      const authorMatch = html.match(/<link\s+itemprop="name"\s+content="([^"]+)"/);

      if (!title && titleMatch) title = titleMatch[1];
      if (!author && authorMatch) author = authorMatch[1];
    }

    return {
      videoId,
      title: title || undefined,
      author: author || undefined,
      duration: duration || undefined,
      description: description || undefined,
    };
  } catch (error: any) {
    throw new Error(`Failed to scrape video info: ${error.message}`);
  }
}

/**
 * Download audio stream from YouTube video
 * Uses yt-dlp with temp file download (not stdout streaming)
 * Stdout streaming causes backpressure in Railway Docker - temp file is reliable
 * Returns a readable stream from the completed download
 */
export async function downloadAudio(videoIdOrUrl: string): Promise<Readable> {
  const videoId = extractVideoId(videoIdOrUrl);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tempPath = join(tmpdir(), `yt-audio-${Date.now()}-${videoId}.m4a`);

  cleanupDebugFiles();

  try {
    // Use system-installed yt-dlp from PATH (installed via nixpacks.toml)
    const ytDlp = new YTDlpWrap('yt-dlp');

    console.log(`Downloading audio to ${tempPath}...`);

    // Download to temp file (NOT stdout - fixes premature close)
    await ytDlp.exec([
      url,
      '-f', 'bestaudio[ext=m4a]/bestaudio',  // Prefer m4a (better for Whisper)
      '-o', tempPath,                        // Explicit file path, NOT stdout
      '--no-playlist',
      '--newline',  // Progress on new lines (easier to parse if needed)
      '--js-runtimes', 'node:/usr/local/bin/node',  // Configure JS runtime for YouTube player script parsing
    ]);

    // Check if file was created (yt-dlp may exit successfully even on 403)
    try {
      await access(tempPath, constants.F_OK);
    } catch {
      throw new Error(
        'YouTube blocked the download (HTTP 403). This video may not be available for audio extraction. ' +
        'Caption-based transcription is more reliable - this video may work if it has captions.'
      );
    }

    // Verify download succeeded
    const stats = await stat(tempPath);
    if (stats.size === 0) {
      throw new Error('yt-dlp created empty file');
    }

    console.log(`Audio downloaded successfully (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);

    // Create read stream from completed file
    const stream = createReadStream(tempPath);

    // Clean up temp file after consumption
    stream.on('end', () => {
      console.log(`Cleaning up temp file: ${tempPath}`);
      unlink(tempPath).catch(() => {});
    });

    stream.on('error', () => {
      // Also cleanup on stream error
      unlink(tempPath).catch(() => {});
    });

    return stream as Readable;

  } catch (error: any) {
    // Clean up on download error
    await unlink(tempPath).catch(() => {});
    throw new Error(`Failed to download audio: ${error.message}`);
  }
}
