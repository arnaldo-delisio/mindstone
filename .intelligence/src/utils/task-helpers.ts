/**
 * Task-Specific Utility Functions
 *
 * Slug generation, frontmatter defaults, checklist helpers,
 * context detection, and shared recurring task completion logic.
 *
 * Checklist lives in body markdown ONLY (not in frontmatter).
 * Body is the single source of truth for checklist state.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextOccurrence } from './recurring-dates.js';

/* -------------------------------------------------------------------------- */
/* TaskFrontmatter interface — events model (Phase 06.1)                       */
/* -------------------------------------------------------------------------- */

export interface TaskFrontmatter {
  title: string;
  status: 'upcoming' | 'done' | 'cancelled' | 'backlog';
  priority: 'low' | 'normal' | 'high';
  urgent: boolean;
  important: boolean;

  // Time fields — presence determines GCal behavior
  start_time?: string | null;      // ISO 8601 — triggers GCal event creation
  end_time?: string | null;        // ISO 8601 — if set with start_time = time block

  // Legacy remind_at kept for migration compatibility (maps to start_time)
  remind_at?: string | null;

  // GCal integration fields
  gcal_event_id?: string | null;   // stored after GCal event created
  gcal_calendar?: string | null;   // 'personal' | 'family' | 'work' | 'health'
  source?: string | null;          // 'gcal' for GCal-imported events, null for vault-created
  source_file?: string | null;     // path to source file for reminder events
  source_file_id?: string | null;  // UUID for source file (flat field — exception to nested convention)

  // Metadata
  calendar?: string;               // user-facing calendar field (same as gcal_calendar)
  context?: string;                // free-form, auto-detected if not set
  tags?: string[];
  blocked_by?: Array<{ path: string; id: string }>; // CHANGED: was string[], now path+id pairs
  recurring?: 'daily' | 'weekly' | 'monthly' | null;
  created: string;                 // YYYY-MM-DD
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Slug generation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Generate a human-readable, timestamp-unique task filename slug.
 *
 * @example
 * makeTaskSlug('Call the dentist!') // 'call-the-dentist-1708531200000'
 */
export function makeTaskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${slug}-${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* Frontmatter defaults                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a TaskFrontmatter object with sensible defaults.
 * All fields in `args` override their defaults.
 *
 * Default status: 'upcoming' for timed events (start_time or remind_at set),
 * 'backlog' for untimed events.
 */
export function buildTaskFrontmatter(args: Partial<TaskFrontmatter>): TaskFrontmatter {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const hasTiming = !!(args.start_time || args.remind_at);
  const defaultStatus = hasTiming ? 'upcoming' : 'backlog';

  return {
    ...args,  // spread first so defaults below always win over undefined values
    title: args.title ?? '',
    status: args.status ?? defaultStatus,
    priority: args.priority ?? 'normal',
    urgent: args.urgent ?? false,
    important: args.important ?? false,
    start_time: args.start_time ?? null,
    end_time: args.end_time ?? null,
    remind_at: args.remind_at ?? null,
    context: args.context,
    tags: args.tags ?? [],
    blocked_by: args.blocked_by ?? [],
    recurring: args.recurring ?? null,
    created: args.created ?? today,
  };
}

/**
 * Returns true if the event has a time anchor (start_time or legacy remind_at).
 * Timed events are eligible for GCal event creation.
 */
export function isTimedEvent(fm: TaskFrontmatter): boolean {
  return !!(fm.start_time || fm.remind_at);
}

/* -------------------------------------------------------------------------- */
/* Checklist helpers (body markdown only)                                       */
/* -------------------------------------------------------------------------- */

const UNCHECKED_ITEM = /^- \[ \] /m;
const CHECKED_ITEM = /^- \[x\] /im;

/**
 * Check if all checklist items in body markdown are completed.
 *
 * Returns false if no checklist items found (no checklist = not complete).
 *
 * @param body - Markdown body text of the task file
 */
export function isChecklistComplete(body: string): boolean {
  const unchecked = body.match(/^- \[ \] .+/gim);
  const checked = body.match(/^- \[x\] .+/gim);

  // No checklist at all
  if (!unchecked && !checked) return false;

  // All items checked (no unchecked remaining)
  return !unchecked && checked !== null && checked.length > 0;
}

/**
 * Reset all completed checklist items back to unchecked.
 * Used when a recurring task cycle completes.
 *
 * @param body - Markdown body text of the task file
 * @returns Updated body with all [x] replaced by [ ]
 */
export function resetChecklist(body: string): string {
  return body.replace(/^(- )\[x\] /gim, '$1[ ] ');
}

/* -------------------------------------------------------------------------- */
/* Context auto-detection                                                       */
/* -------------------------------------------------------------------------- */

interface ContextRule {
  context: string;
  keywords: string[];
}

const CONTEXT_RULES: ContextRule[] = [
  {
    context: 'personal',
    keywords: [
      'buy', 'groceries', 'shopping', 'dentist', 'doctor', 'health', 'gym',
      'family', 'home', 'clean', 'repair', 'appointment', 'personal',
    ],
  },
  {
    context: 'work',
    keywords: [
      'fix', 'debug', 'build', 'deploy', 'code', 'review', 'meeting',
      'client', 'feature', 'bug', 'pr', 'pull request', 'commit', 'test',
      'release', 'ship', 'project', 'work',
    ],
  },
  {
    context: 'vault',
    keywords: [
      'vault', 'notes', 'moc', 'learning', 'library', 'skill', 'daemon',
      'intelligence', 'sync', 'backup', 'archive',
    ],
  },
  {
    context: 'learning',
    keywords: [
      'study', 'learn', 'read', 'book', 'course', 'practice', 'exercise',
      'research', 'watch', 'tutorial', 'lesson', 'chapter',
    ],
  },
  {
    context: 'finance',
    keywords: [
      'pay', 'payment', 'invoice', 'bill', 'tax', 'bank', 'money', 'budget',
      'expense', 'financial', 'finance', 'transfer',
    ],
  },
];

/**
 * Auto-detect task context from content using keyword matching.
 *
 * Matches keywords case-insensitively. First rule with any match wins.
 * Returns 'general' if no keywords match.
 *
 * @param content - Combined title + body text to scan
 */
export function detectContext(content: string): string {
  const lower = content.toLowerCase();

  for (const rule of CONTEXT_RULES) {
    const matched = rule.keywords.some(kw => lower.includes(kw));
    if (matched) return rule.context;
  }

  return 'general';
}

/* -------------------------------------------------------------------------- */
/* Recurring event completion (shared between manage_event MCP and action endpoints) */
/* -------------------------------------------------------------------------- */

export interface RecurringCompletionResult {
  newRemindAt: string;
  id?: string;
}

/**
 * Complete a recurring task cycle:
 * 1. Compute next remind_at via nextOccurrence()
 * 2. Append completion entry to ## Completions section in body
 * 3. Reset checklist if present
 * 4. Update DB: frontmatter (new remind_at) + body + content_hash + updated_at = NOW()
 *
 * Shared by manage_event MCP tool and action endpoints.
 * Accepts supabase client as arg for testability.
 *
 * @param supabase   - Authenticated Supabase client
 * @param path       - File path in vault (e.g. "events/call-dentist-1234.md")
 * @param userId     - User UUID
 * @param frontmatter - Current task frontmatter (must have recurring and start_time or remind_at)
 * @param body       - Current file body (markdown below frontmatter)
 * @param note       - Optional completion note appended to ## Completions entry
 */
export async function completeRecurringTask(
  supabase: SupabaseClient,
  path: string,
  userId: string,
  frontmatter: TaskFrontmatter,
  body: string,
  note?: string,
  id?: string
): Promise<RecurringCompletionResult> {
  if (!frontmatter.recurring) {
    throw new Error('completeRecurringTask called on non-recurring task');
  }
  // Support both start_time (new) and remind_at (legacy migration compatibility)
  const timeAnchor = frontmatter.start_time || frontmatter.remind_at;
  if (!timeAnchor) {
    throw new Error('completeRecurringTask: event has no start_time or remind_at to bump');
  }

  // 1. Compute next occurrence
  const newRemindAt = nextOccurrence(timeAnchor, frontmatter.recurring);

  // 2. Append to ## Completions section
  const completionDate = new Date().toISOString().split('T')[0];
  const completionLine = note
    ? `- ${completionDate}: Done — ${note}`
    : `- ${completionDate}: Done`;

  let updatedBody = body;
  if (updatedBody.includes('## Completions')) {
    // Insert after the ## Completions heading line
    updatedBody = updatedBody.replace(
      /(## Completions\n)/,
      `$1${completionLine}\n`
    );
  } else {
    // Append ## Completions section at end of body
    updatedBody = updatedBody.trimEnd() + `\n\n## Completions\n${completionLine}\n`;
  }

  // 3. Reset checklist if present
  updatedBody = resetChecklist(updatedBody);

  // 4. Build updated frontmatter
  // Update start_time (new model) and keep remind_at in sync for migration compat
  const updatedFrontmatter: TaskFrontmatter = {
    ...frontmatter,
    start_time: newRemindAt,
    remind_at: newRemindAt,
    // Recurring tasks never get status: 'done'
  };

  // 5. Reconstruct full file content for content_hash
  const matter = await import('gray-matter');
  const newContent = matter.default.stringify(updatedBody, updatedFrontmatter);
  const content_hash = createHash('sha256').update(newContent).digest('hex');

  // 6. Update DB
  const { error } = await supabase
    .from('files')
    .update({
      frontmatter: updatedFrontmatter,
      body: updatedBody,
      content_hash,
      updated_at: new Date().toISOString(),
    })
    .eq('path', path)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`completeRecurringTask DB update failed: ${error.message}`);
  }

  return { newRemindAt, id };
}
