/**
 * EPUB Text Extractor
 *
 * Extracts clean text from EPUB files by:
 * 1. Unzipping the EPUB archive
 * 2. Parsing the OPF manifest to get reading order
 * 3. Extracting text from XHTML/HTML content files
 * 4. Cleaning HTML tags and formatting as markdown
 *
 * EPUBs don't need AI extraction - they already contain structured text.
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';

interface EpubMetadata {
  title?: string;
  creator?: string;
  publisher?: string;
  description?: string;
}

interface SpineItem {
  idref: string;
  linear?: string;
}

interface ManifestItem {
  id: string;
  href: string;
  'media-type': string;
}

/**
 * Extract text content from EPUB file
 */
export async function extractFromEpub(buffer: Buffer): Promise<{
  text: string;
  metadata: EpubMetadata;
}> {
  // Unzip the EPUB
  const zip = await JSZip.loadAsync(buffer);

  // Find the OPF file (package document)
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) {
    throw new Error('Invalid EPUB: Missing META-INF/container.xml');
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const container = parser.parse(containerXml);
  const opfPath = container.container.rootfiles.rootfile['full-path'];

  // Parse the OPF file
  const opfXml = await zip.file(opfPath)?.async('text');
  if (!opfXml) {
    throw new Error(`Invalid EPUB: Missing OPF file at ${opfPath}`);
  }

  const opf = parser.parse(opfXml);
  const packageData = opf.package;

  // Extract metadata
  const metadata = extractMetadata(packageData.metadata);

  // Get the spine (reading order) and manifest (file locations)
  const spine: SpineItem[] = Array.isArray(packageData.spine.itemref)
    ? packageData.spine.itemref
    : [packageData.spine.itemref];

  const manifestItems: ManifestItem[] = Array.isArray(packageData.manifest.item)
    ? packageData.manifest.item
    : [packageData.manifest.item];

  // Create a map of id -> href
  const manifestMap = new Map<string, string>();
  manifestItems.forEach((item) => {
    manifestMap.set(item.id, item.href);
  });

  // Extract text from content files in reading order
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  const textChunks: string[] = [];

  for (const item of spine) {
    // Skip non-linear items (footnotes, etc.)
    if (item.linear === 'no') continue;

    const href = manifestMap.get(item.idref);
    if (!href) continue;

    const contentPath = opfDir + href;
    const content = await zip.file(contentPath)?.async('text');
    if (!content) continue;

    // Extract text from HTML/XHTML
    const text = extractTextFromHtml(content);
    if (text.trim()) {
      textChunks.push(text);
    }
  }

  // Combine all text with double newlines between chapters
  const fullText = textChunks.join('\n\n---\n\n');

  return {
    text: fullText,
    metadata
  };
}

/**
 * Extract metadata from OPF
 */
function extractMetadata(metadata: any): EpubMetadata {
  const result: EpubMetadata = {};

  // Handle various metadata formats
  if (metadata['dc:title']) {
    result.title = typeof metadata['dc:title'] === 'string'
      ? metadata['dc:title']
      : metadata['dc:title']['#text'] || metadata['dc:title'][0];
  }

  if (metadata['dc:creator']) {
    result.creator = typeof metadata['dc:creator'] === 'string'
      ? metadata['dc:creator']
      : metadata['dc:creator']['#text'] || metadata['dc:creator'][0];
  }

  if (metadata['dc:publisher']) {
    result.publisher = typeof metadata['dc:publisher'] === 'string'
      ? metadata['dc:publisher']
      : metadata['dc:publisher']['#text'];
  }

  if (metadata['dc:description']) {
    result.description = typeof metadata['dc:description'] === 'string'
      ? metadata['dc:description']
      : metadata['dc:description']['#text'];
  }

  return result;
}

/**
 * Extract clean text from HTML/XHTML content
 */
function extractTextFromHtml(html: string): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Remove script and style tags
  document.querySelectorAll('script, style').forEach((el) => el.remove());

  // Get text content
  let text = document.body.textContent || '';

  // Clean up whitespace
  text = text
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Multiple newlines to double newline
    .replace(/[ \t]+/g, ' ') // Multiple spaces to single space
    .replace(/^\s+|\s+$/gm, '') // Trim lines
    .trim();

  return text;
}

/**
 * Format extraction result as markdown with frontmatter
 */
export function formatEpubAsMarkdown(
  text: string,
  metadata: EpubMetadata,
  filename: string
): string {
  const title = metadata.title || filename.replace('.epub', '');
  const author = metadata.creator || 'Unknown';

  let markdown = `# ${title}\n`;
  if (author) {
    markdown += `**Author:** ${author}\n`;
  }
  if (metadata.publisher) {
    markdown += `**Publisher:** ${metadata.publisher}\n`;
  }
  markdown += `\n---\n\n`;
  markdown += text;

  return markdown;
}
