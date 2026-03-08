// PDF Content Extractor using Gemini 2.5 Flash-Lite
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractFromEpub, formatEpubAsMarkdown } from './epub-extractor.js';

export interface GeminiExtractionResult {
  title: string;
  content: string;
  author?: string;
  publishedDate?: string;
  pageCount: number;
  fileSize: number;
  wordCount: number;
  sourceType: 'pdf' | 'epub' | 'docx';
  originalFileName: string;
}

export class GeminiExtractor {
  private genAI: GoogleGenerativeAI | null = null;
  private fileManager: GoogleAIFileManager | null = null;

  /**
   * Check if Gemini API is available
   */
  isAvailable(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  /**
   * Initialize Gemini client (lazy initialization)
   */
  private getClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error(
          'PDF extraction requires GEMINI_API_KEY. ' +
          'Get from: https://aistudio.google.com -> Get API key. ' +
          'Free tier: 1M tokens/day (~50 PDFs/month), Paid: $0.30/1M input tokens'
        );
      }
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return this.genAI;
  }

  /**
   * Initialize Gemini File Manager (lazy initialization)
   */
  private getFileManager(): GoogleAIFileManager {
    if (!this.fileManager) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required for File API');
      }
      this.fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
    }
    return this.fileManager;
  }

  /**
   * Extract content using Gemini File API (for large files >20MB)
   * Files auto-expire after 24 hours, no manual cleanup needed
   */
  private async extractWithFileApi(
    fileBuffer: Buffer,
    mimeType: string,
    fileName: string,
    sourceType: 'pdf' | 'epub' | 'docx',
    geminiMimeType: string,
    estimatedPages: number
  ): Promise<GeminiExtractionResult> {
    const fileManager = this.getFileManager();
    const genAI = this.getClient();

    // Write buffer to temporary file
    const tempFilePath = join(tmpdir(), `gemini-upload-${Date.now()}-${fileName}`);
    let uploadedFile;

    try {
      writeFileSync(tempFilePath, fileBuffer);

      // Upload file to Gemini File API
      uploadedFile = await fileManager.uploadFile(tempFilePath, {
        mimeType: geminiMimeType,
        displayName: fileName
      });

      // Initialize model
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

      // Extract content using file URI
      const result = await model.generateContent([
        {
          fileData: {
            mimeType: uploadedFile.file.mimeType,
            fileUri: uploadedFile.file.uri
          }
        },
        'Extract all text from this document and format as clean markdown. ' +
        'Preserve structure with headings, lists, and paragraphs. ' +
        'Include any tables as markdown tables. ' +
        'If metadata is visible (author, publication date, title), note it at the start.'
      ]);

      const response = await result.response;
      const content = response.text();

      // Calculate word count
      const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

      // Extract title from content or filename
      const title = this.extractTitle(content, fileName);

      // Try to extract metadata from content
      const metadata = this.extractMetadata(content);

      return {
        title,
        content,
        author: metadata.author,
        publishedDate: metadata.publishedDate,
        pageCount: estimatedPages,
        fileSize: fileBuffer.length,
        wordCount,
        sourceType,
        originalFileName: fileName
      };

    } catch (error: any) {
      throw new Error(
        `Failed to extract ${sourceType.toUpperCase()} with File API: ${error.message || String(error)}`
      );
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tempFilePath);
      } catch (err) {
        // Ignore cleanup errors
      }
      // Note: Uploaded files auto-expire after 24 hours, no API cleanup needed
    }
  }

  /**
   * Extract content from file buffer (for uploaded files)
   */
  async extractFromBuffer(
    fileBuffer: Buffer,
    mimeType: string,
    fileName: string
  ): Promise<GeminiExtractionResult> {
    const fileSize = fileBuffer.length;

    // Handle EPUB files with dedicated extractor (no Gemini needed)
    if (mimeType === 'application/epub+zip') {
      const { text, metadata } = await extractFromEpub(fileBuffer);
      const content = formatEpubAsMarkdown(text, metadata, fileName);

      return {
        title: metadata.title || fileName.replace('.epub', ''),
        content,
        author: metadata.creator,
        publishedDate: undefined,
        pageCount: 0, // EPUBs don't have fixed pages
        fileSize,
        wordCount: content.split(/\s+/).length,
        sourceType: 'epub',
        originalFileName: fileName
      };
    }

    // For PDFs and other formats, use Gemini
    const genAI = this.getClient();

    // Estimate page count (avg 50KB per page)
    const estimatedPages = Math.max(1, Math.round(fileSize / 51200));

    // Map mimetype to source type and Gemini mime type
    let sourceType: 'pdf' | 'epub' | 'docx';
    let geminiMimeType: string;

    if (mimeType === 'application/pdf') {
      sourceType = 'pdf';
      geminiMimeType = 'application/pdf';
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      sourceType = 'docx';
      geminiMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      throw new Error(`Unsupported mime type: ${mimeType}`);
    }

    // Use File API for large files (>20MB) to avoid inline data limit
    const SIZE_THRESHOLD = 20 * 1024 * 1024; // 20MB
    if (fileSize > SIZE_THRESHOLD) {
      return this.extractWithFileApi(
        fileBuffer,
        mimeType,
        fileName,
        sourceType,
        geminiMimeType,
        estimatedPages
      );
    }

    // For small files, use inline extraction (faster, no file upload needed)
    // Initialize Gemini model (2.5 Flash-Lite: 3x cheaper, higher rate limits than 2.0)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    // Extract content with Gemini
    try {
      const result = await model.generateContent([
        {
          inlineData: {
            data: fileBuffer.toString('base64'),
            mimeType: geminiMimeType
          }
        },
        'Extract all text from this document and format as clean markdown. ' +
        'Preserve structure with headings, lists, and paragraphs. ' +
        'Include any tables as markdown tables. ' +
        'If metadata is visible (author, publication date, title), note it at the start.'
      ]);

      const response = await result.response;
      const content = response.text();

      // Calculate word count
      const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

      // Extract title from content or filename
      const title = this.extractTitle(content, fileName);

      // Try to extract metadata from content
      const metadata = this.extractMetadata(content);

      return {
        title,
        content,
        author: metadata.author,
        publishedDate: metadata.publishedDate,
        pageCount: estimatedPages,
        fileSize,
        wordCount,
        sourceType,
        originalFileName: fileName
      };

    } catch (error: any) {
      throw new Error(
        `Failed to extract ${sourceType.toUpperCase()} with Gemini: ${error.message || String(error)}`
      );
    }
  }

  /**
   * Extract content from PDF file (for file path inputs)
   */
  async extractFromFile(
    filePath: string,
    fileName: string
  ): Promise<GeminiExtractionResult> {
    // Read file and convert to buffer, then use extractFromBuffer
    const fileStats = statSync(filePath);
    const fileBuffer = readFileSync(filePath);

    // Determine mime type from file extension
    let mimeType = 'application/pdf';
    if (fileName.toLowerCase().endsWith('.epub')) {
      mimeType = 'application/epub+zip';
    } else if (fileName.toLowerCase().endsWith('.docx')) {
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    return this.extractFromBuffer(fileBuffer, mimeType, fileName);
  }

  /**
   * Extract title from content or filename
   */
  private extractTitle(content: string, fileName: string): string {
    // Try to find first # heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    // Try to find bold text that looks like a title in first 500 chars
    const firstPart = content.slice(0, 500);
    const boldMatch = firstPart.match(/\*\*(.+?)\*\*/);
    if (boldMatch && boldMatch[1].length < 100) {
      return boldMatch[1].trim();
    }

    // Fall back to filename without extension
    return fileName
      .replace(/\.(pdf|epub|docx)$/i, '')
      .replace(/[-_]/g, ' ');
  }

  /**
   * Extract metadata from content if present
   */
  private extractMetadata(content: string): {
    author?: string;
    publishedDate?: string;
  } {
    const metadata: { author?: string; publishedDate?: string } = {};

    // Look in first 1000 chars for common metadata patterns
    const firstPart = content.slice(0, 1000);

    // Try to find author
    const authorPatterns = [
      /(?:Author|By|Written by):\s*([^\n]+)/i,
      /\*\*Author\*\*:\s*([^\n]+)/i
    ];
    for (const pattern of authorPatterns) {
      const match = firstPart.match(pattern);
      if (match) {
        metadata.author = match[1].trim();
        break;
      }
    }

    // Try to find date
    const datePatterns = [
      /(?:Date|Published|Publication Date):\s*([^\n]+)/i,
      /\*\*Date\*\*:\s*([^\n]+)/i,
      /(\d{4}-\d{2}-\d{2})/,
      /(\w+ \d{1,2},? \d{4})/
    ];
    for (const pattern of datePatterns) {
      const match = firstPart.match(pattern);
      if (match) {
        metadata.publishedDate = match[1].trim();
        break;
      }
    }

    return metadata;
  }
}
