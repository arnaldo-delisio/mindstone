import { SupabaseClient } from '@supabase/supabase-js';
import { mocGeneratorLogger as logger } from '../utils/logger.js';

export const MOC_THRESHOLD = 5;

/**
 * Update moc_memberships denormalized field for all files linked in a MOC
 * Called during MOC generation to keep memberships in sync
 */
async function updateMOCMemberships(
  mocTopic: string,
  linkedPaths: string[],
  userId: string,
  supabase: SupabaseClient
): Promise<void> {
  logger.debug({ mocTopic, linkedPathsCount: linkedPaths.length }, '[MOC] Updating memberships');

  // Step 1: Clear this MOC from all files (remove from array)
  const { error: clearError } = await supabase.rpc('remove_moc_membership', {
    p_user_id: userId,
    p_moc_topic: mocTopic
  });

  if (clearError) {
    logger.error({ error: clearError, mocTopic }, '[MOC] Failed to clear memberships');
    throw new Error(`Failed to clear MOC memberships: ${clearError.message}`);
  }

  logger.debug({ mocTopic }, '[MOC] Cleared MOC from all files');

  // Step 2: Add MOC topic to linked files (append to array)
  for (const path of linkedPaths) {
    const { error: addError } = await supabase.rpc('add_moc_membership', {
      p_user_id: userId,
      p_file_path: path,
      p_moc_topic: mocTopic
    });

    if (addError) {
      logger.warn({ error: addError, path, mocTopic }, '[MOC] Failed to add membership');
      // Continue with other files - partial failure acceptable
    }
  }

  logger.info({ mocTopic, linkedPathsCount: linkedPaths.length }, '[MOC] Updated memberships');
}

/**
 * Extract linked file paths from MOC content
 * Parses wiki-style links: [[path|title]] or [[path]]
 */
function extractLinkedPaths(mocContent: string): string[] {
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const paths: string[] = [];
  let match;

  while ((match = wikiLinkRegex.exec(mocContent)) !== null) {
    paths.push(match[1]);
  }

  return paths;
}

interface FileRecord {
  path: string;
  frontmatter: any;
  body: string;
  created_at: string;
}

interface MOCResult {
  path: string;
  content: string;
  frontmatter: {
    title: string;
    topic: string;
    item_count: number;
    learnings_count: number;
    sources_count: number;
    generated_at: string;
    type: string;
  };
  learningsCount: number;
  sourcesCount: number;
}

/**
 * Fetch content files for a user (excluding daily/, queue/, mocs/)
 */
async function fetchContentFiles(
  userId: string,
  supabase: SupabaseClient
): Promise<FileRecord[]> {
  const { data: allFiles, error: fetchError } = await supabase
    .from('files')
    .select('path,frontmatter,body,created_at')
    .eq('user_id', userId);

  if (fetchError) {
    logger.error({ error: fetchError, userId }, 'Failed to fetch files for MOC generation');
    throw new Error(`Failed to fetch files: ${fetchError.message}`);
  }

  // Filter out transient/excluded paths and MOCs (which shouldn't count toward thresholds)
  return (allFiles || []).filter((f: FileRecord) =>
    !f.path.startsWith('daily/') &&
    !f.path.startsWith('queue/') &&
    !f.path.startsWith('mocs/')
  );
}

/**
 * Get files with a specific tag
 */
function getFilesWithTag(contentFiles: FileRecord[], tag: string): FileRecord[] {
  return contentFiles.filter((f: FileRecord) =>
    f.frontmatter?.tags && Array.isArray(f.frontmatter.tags) && f.frontmatter.tags.includes(tag)
  );
}

/**
 * Check if a tag meets the MOC threshold (5+ files)
 * Returns the count and whether threshold is met
 */
export async function checkMOCThresholdOnly(
  tag: string,
  userId: string,
  supabase: SupabaseClient
): Promise<{ needsMOC: boolean; count: number; threshold: number }> {
  const contentFiles = await fetchContentFiles(userId, supabase);
  const filesWithTag = getFilesWithTag(contentFiles, tag);
  const count = filesWithTag.length;

  logger.debug({ tag, count, threshold: MOC_THRESHOLD }, 'Checked MOC threshold');

  return {
    needsMOC: count >= MOC_THRESHOLD,
    count,
    threshold: MOC_THRESHOLD
  };
}

/**
 * Generate MOC for a specific tag (regardless of threshold)
 * Returns the generated MOC content and metadata
 */
export async function generateMOC(
  tag: string,
  userId: string,
  supabase: SupabaseClient
): Promise<MOCResult> {
  logger.info({ tag, userId }, 'Generating MOC');

  const contentFiles = await fetchContentFiles(userId, supabase);
  const filesWithTag = getFilesWithTag(contentFiles, tag);

  if (filesWithTag.length === 0) {
    throw new Error(`No files found with tag: ${tag}`);
  }

  // Sort files by created_at desc (most recent first)
  const files = filesWithTag.sort((a: FileRecord, b: FileRecord) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Build MOC content with separated Learnings and Sources sections
  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);
  const title = capitalize(tag);

  // Separate files by type
  const learnings = files.filter((f: FileRecord) => f.path.startsWith('learnings/'));
  const sources = files.filter((f: FileRecord) => f.path.startsWith('library/'));

  let mocContent = `# ${title} - Map of Content\n\n`;
  mocContent += `${learnings.length + sources.length} items on ${tag}\n\n`;
  mocContent += `---\n\n`;

  // Learnings section (if any)
  if (learnings.length > 0) {
    mocContent += `## Learnings\n\n`;
    for (const file of learnings) {
      const fileTitle = file.frontmatter?.title || file.frontmatter?.source_title || 'Untitled';
      const filePath = file.path;

      // Extract first meaningful line as snippet
      const firstLine = file.body
        .split('\n')
        .find((l: string) => l.trim().length > 0) || '';
      const snippet = firstLine.length > 100
        ? firstLine.substring(0, 100) + '...'
        : firstLine;

      // Use wiki-style links: [[path|title]]
      mocContent += `### [[${filePath}|${fileTitle}]]\n`;
      mocContent += `${snippet}\n\n`;
    }
  }

  // Sources section (if any)
  if (sources.length > 0) {
    mocContent += `## Sources\n\n`;
    for (const file of sources) {
      const fileTitle = file.frontmatter?.title || file.frontmatter?.source_title || 'Untitled';
      const filePath = file.path;

      // Extract first meaningful line as snippet
      const firstLine = file.body
        .split('\n')
        .find((l: string) => l.trim().length > 0) || '';
      const snippet = firstLine.length > 100
        ? firstLine.substring(0, 100) + '...'
        : firstLine;

      // Use wiki-style links: [[path|title]]
      mocContent += `### [[${filePath}|${fileTitle}]]\n`;
      mocContent += `${snippet}\n\n`;
    }
  }

  // Prepare frontmatter with section counts
  const frontmatter = {
    title: `${title} - Map of Content`,
    topic: tag,
    item_count: learnings.length + sources.length,
    learnings_count: learnings.length,
    sources_count: sources.length,
    generated_at: new Date().toISOString().split('T')[0],
    type: 'moc'
  };

  const mocPath = `mocs/${tag}.md`;

  logger.info(
    { tag, mocPath, learningsCount: learnings.length, sourcesCount: sources.length },
    'MOC generated'
  );

  return {
    path: mocPath,
    content: mocContent,
    frontmatter,
    learningsCount: learnings.length,
    sourcesCount: sources.length
  };
}

/**
 * Generate MOC and persist to database
 * Used by HTTP API when user explicitly requests MOC generation
 */
export async function generateAndPersistMOC(
  tag: string,
  userId: string,
  supabase: SupabaseClient
): Promise<MOCResult> {
  const moc = await generateMOC(tag, userId, supabase);

  // Compute content hash for daemon sync detection
  // Use gray-matter to reconstruct the full content (YAML frontmatter + body)
  // This matches how the daemon reconstructs files, ensuring consistent hashing
  const matter = await import('gray-matter');
  const crypto = await import('crypto');
  const fullMOCContent = matter.default.stringify(moc.content, moc.frontmatter);
  const mocHash = crypto.createHash('sha256').update(fullMOCContent).digest('hex');

  // CRITICAL: Upsert MOC to database (create or update)
  // This ensures MOC persists to database AND syncs to vault via daemon
  const { error: upsertError } = await supabase
    .from('files')
    .upsert({
      user_id: userId,
      path: moc.path,
      body: moc.content,
      frontmatter: moc.frontmatter,
      content_hash: mocHash,
      updated_at: new Date().toISOString(),
      intelligence_status: 'complete' // MOCs don't need intelligence processing
    }, {
      onConflict: 'user_id,path'
    });

  if (upsertError) {
    logger.error({ error: upsertError, tag, path: moc.path }, 'Failed to upsert MOC');
    throw new Error(`Failed to persist MOC: ${upsertError.message}`);
  }

  logger.info({ tag, path: moc.path }, 'MOC persisted to database');

  // Update moc_memberships for all linked files
  const linkedPaths = extractLinkedPaths(moc.content);
  await updateMOCMemberships(tag, linkedPaths, userId, supabase);

  return moc;
}

/**
 * Check MOC threshold for tags and generate MOCs if needed
 * Used by queue processor for automatic MOC generation after tagging
 *
 * MOCs are generated when a topic reaches 5+ files (any type: learnings, videos, articles, etc.)
 *
 * CRITICAL: Upserts generated MOC to files table for persistence and daemon sync
 */
export async function checkMOCThreshold(
  tags: string[],
  userId: string,
  supabase: SupabaseClient
): Promise<void> {
  const uniqueTags = Array.from(new Set(tags));

  logger.debug({ tags: uniqueTags, userId }, 'Checking MOC thresholds');

  const contentFiles = await fetchContentFiles(userId, supabase);

  logger.debug({ contentFiles: contentFiles.length }, 'Files loaded for threshold check');

  for (const tag of uniqueTags) {
    try {
      const filesWithTag = getFilesWithTag(contentFiles, tag);
      const count = filesWithTag.length;

      // Skip if threshold not reached
      if (count < MOC_THRESHOLD) {
        logger.debug({ tag, count, threshold: MOC_THRESHOLD }, 'Below MOC threshold, skipping');
        continue;
      }

      logger.info({ tag, count }, 'MOC threshold reached, generating MOC');

      // Generate and persist the MOC
      await generateAndPersistMOC(tag, userId, supabase);

    } catch (error) {
      logger.error({ error, tag }, 'Failed to process MOC threshold for tag');
      // Continue with other tags even if one fails
    }
  }
}
