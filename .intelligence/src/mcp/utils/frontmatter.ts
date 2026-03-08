import matter from 'gray-matter';

/**
 * Frontmatter utilities for vault files
 */

/**
 * Create frontmatter for learning files
 */
export function createLearningFrontmatter(
  sourceUrl: string,
  tags: string[],
  metadata?: {
    source_title?: string;
    source_author?: string;
    source_duration?: number;
    source_url?: string;
  }
) {
  return {
    created_at: new Date().toISOString(),
    source_url: sourceUrl,
    tags,
    type: 'learning',
    ...(metadata?.source_title && { source_title: metadata.source_title }),
    ...(metadata?.source_author && { source_author: metadata.source_author }),
    ...(metadata?.source_duration && { source_duration_minutes: Math.floor(metadata.source_duration / 60) }),
  };
}

/**
 * Create frontmatter for daily journal files
 */
export function createDailyFrontmatter() {
  return {
    created_at: new Date().toISOString(),
    type: 'daily'
  };
}

/**
 * Detect category based on content keywords
 */
export function detectCategory(content: string): string {
  const lowerContent = content.toLowerCase();

  // Work keywords
  const workKeywords = ['phase', 'plan', 'gsd', 'planning', 'development', 'bug', 'fix',
    'infrastructure', '.mcp', '.daemon', 'supabase', 'database', 'migration', 'deployment',
    'completed', 'implemented', 'built', 'fixed'];

  // Content keywords
  const contentKeywords = ['video', 'post', 'article', 'tweet', 'blog', 'publish', 'content',
    'remotion', 'postiz', 'script', 'recording', 'editing', 'social media'];

  // Learning keywords
  const learningKeywords = ['learning', 'insight', 'synthesis', 'discovered', 'til',
    'captured', 'extracted', 'summarized', 'learned'];

  // Ideas keywords
  const ideasKeywords = ['idea', 'future', 'maybe', 'experiment', 'explore', 'consider',
    'random thought', 'interesting'];

  // Check each category
  if (contentKeywords.some(kw => lowerContent.includes(kw))) return 'Content';
  if (learningKeywords.some(kw => lowerContent.includes(kw))) return 'Learning';
  if (ideasKeywords.some(kw => lowerContent.includes(kw))) return 'Ideas';
  if (workKeywords.some(kw => lowerContent.includes(kw))) return 'Work';

  // Default to Work
  return 'Work';
}

/**
 * Append content to daily journal with timestamp and category
 * Handles section creation and maintains format: - HH:MM - [content]
 */
export function appendToDailyCategorized(existingBody: string | null, content: string, category?: string): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const timestamp = `${hours}:${minutes}`;

  // Auto-detect category if not provided
  const detectedCategory = category || detectCategory(content);

  // Format the entry
  const entry = `- ${timestamp} - ${content}`;

  // If no existing body, create with date header and first section
  if (!existingBody || existingBody.trim() === '') {
    const today = new Date().toISOString().split('T')[0];
    return `# ${today}\n\n## ${detectedCategory}\n${entry}\n`;
  }

  // Check if category section exists
  const sectionRegex = new RegExp(`^## ${detectedCategory}$`, 'm');

  if (sectionRegex.test(existingBody)) {
    // Section exists - find where to insert the entry
    const sections = existingBody.split(/^## /m);
    let result = '';
    let foundSection = false;

    for (let i = 0; i < sections.length; i++) {
      if (i === 0) {
        // Keep everything before first section (date header, etc.)
        result += sections[i];
        continue;
      }

      const sectionContent = sections[i];
      const sectionName = sectionContent.split('\n')[0];

      if (sectionName === detectedCategory) {
        // Found our section - append entry
        result += `## ${sectionContent.trimEnd()}\n${entry}\n`;
        foundSection = true;
      } else {
        result += `## ${sectionContent}`;
      }
    }

    return result;
  } else {
    // Section doesn't exist - add it in the right order
    const sectionOrder = ['Work', 'Content', 'Learning', 'Ideas'];
    const currentSections = existingBody.match(/^## (.+)$/gm) || [];
    const currentSectionNames = currentSections.map(s => s.replace('## ', ''));

    // Find where to insert the new section
    let insertIndex = sectionOrder.indexOf(detectedCategory);
    let insertBefore: string | null = null;

    for (let i = insertIndex + 1; i < sectionOrder.length; i++) {
      if (currentSectionNames.includes(sectionOrder[i])) {
        insertBefore = sectionOrder[i];
        break;
      }
    }

    if (insertBefore) {
      // Insert before a later section
      const insertRegex = new RegExp(`^## ${insertBefore}$`, 'm');
      return existingBody.replace(insertRegex, `## ${detectedCategory}\n${entry}\n\n## ${insertBefore}`);
    } else {
      // Append at the end
      return `${existingBody.trimEnd()}\n\n## ${detectedCategory}\n${entry}\n`;
    }
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use appendToDailyCategorized instead
 */
export function appendToDaily(content: string): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `## ${hours}:${minutes}\n${content}\n\n`;
}
