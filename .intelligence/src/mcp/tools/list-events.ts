/**
 * list_events MCP tool (renamed from list_tasks in Phase 06.1)
 *
 * Filtered event listing grouped by context, sorted by priority.
 * Returns structured JSON — Claude formats for display (works for both
 * Claude Mobile and Claude Code).
 *
 * Blocked events shown inline with [blocked by: X] label.
 * Supports filter: today | upcoming | backlog | all
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import type { TaskFrontmatter } from '../../utils/task-helpers.js';

/* -------------------------------------------------------------------------- */
/* Interfaces                                                                   */
/* -------------------------------------------------------------------------- */

export interface ListEventsArgs {
  /** Default: 'upcoming' — events in next 7 days with start_time */
  filter?: 'today' | 'upcoming' | 'backlog' | 'all';
  priority?: 'low' | 'normal' | 'high';
  context?: string;
  tag?: string;
  /** Show blocked events inline with label (default: true) */
  show_blocked?: boolean;
}

export interface EventSummary {
  id: string;
  path: string;
  title: string;
  status: string;
  priority: string;
  urgent: boolean;
  important: boolean;
  start_time: string | null;
  end_time: string | null;
  context: string;
  tags: string[];
  recurring: string | null;
  blocked_by_label: string | null;
  checklist_progress: string | null; // e.g. "2/5"
}

interface ListEventsResult {
  success: boolean;
  events: Record<string, EventSummary[]>;
  total: number;
  overdue_count: number;
  triage_suggested: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Priority sort order                                                          */
/* -------------------------------------------------------------------------- */

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

function prioritySortKey(event: EventSummary): number {
  // urgent+important first (Eisenhower top-left)
  if (event.urgent && event.important) return -1;
  return PRIORITY_ORDER[event.priority] ?? 1;
}

/* -------------------------------------------------------------------------- */
/* Checklist progress helper                                                   */
/* -------------------------------------------------------------------------- */

function getChecklistProgress(body: string): string | null {
  const unchecked = (body.match(/^- \[ \] .+/gim) || []).length;
  const checked = (body.match(/^- \[x\] .+/gim) || []).length;
  const total = unchecked + checked;

  if (total === 0) return null;
  return `${checked}/${total}`;
}

/* -------------------------------------------------------------------------- */
/* Tool implementation                                                          */
/* -------------------------------------------------------------------------- */

export async function listEventsTool(args: ListEventsArgs): Promise<ListEventsResult> {
  const {
    filter = 'upcoming',
    priority,
    context,
    tag,
    show_blocked = true,
  } = args;

  try {
    // 1. Fetch all events for this user
    const { data, error } = await supabase
      .from('files')
      .select('id, path, frontmatter, body')
      .like('path', 'events/%')
      .eq('user_id', USER_ID);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return {
        success: true,
        events: {},
        total: 0,
        overdue_count: 0,
        triage_suggested: false,
      };
    }

    // 2. Build a map of all event paths → frontmatter for blocker resolution
    const eventMap = new Map<string, TaskFrontmatter>(
      data.map((row: { id: string; path: string; frontmatter: TaskFrontmatter; body: string }) => [
        row.path,
        row.frontmatter,
      ])
    );

    // 3. Apply filter and frontmatter filters
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const sevenDaysFromNow = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    let overdueCount = 0;

    const filtered = data.filter((row: { id: string; path: string; frontmatter: TaskFrontmatter; body: string }) => {
      const fm = row.frontmatter;

      if (!fm) return false;

      // Skip cancelled events
      if (fm.status === 'cancelled') return false;

      // Apply time-based filter
      const timeAnchor = fm.start_time || fm.remind_at;

      if (filter === 'today') {
        if (!timeAnchor) return false;
        const eventDate = new Date(timeAnchor);
        return eventDate >= todayStart && eventDate < todayEnd;
      }

      if (filter === 'upcoming') {
        if (!timeAnchor) return false;
        const eventDate = new Date(timeAnchor);
        return eventDate >= now && eventDate < sevenDaysFromNow;
      }

      if (filter === 'backlog') {
        return !timeAnchor && fm.status === 'backlog';
      }

      // filter === 'all': include everything non-cancelled
      // (skip done unless explicitly requested)
      if (fm.status === 'done') return false;

      // Priority filter
      if (priority && fm.priority !== priority) return false;

      // Context filter (case-insensitive substring)
      if (context && !(fm.context ?? '').toLowerCase().includes(context.toLowerCase())) return false;

      // Tag filter
      if (tag && !(fm.tags ?? []).some((t: string) => t.toLowerCase() === tag.toLowerCase())) return false;

      return true;
    });

    // 4. Process events: resolve blockers + compute overdue + build EventSummary
    const eventSummaries: EventSummary[] = filtered.map((row: { id: string; path: string; frontmatter: TaskFrontmatter; body: string }) => {
      const fm = row.frontmatter;
      const body = row.body || '';

      const timeAnchor = fm.start_time || fm.remind_at;

      // Check if overdue (has start_time in the past and not done)
      if (timeAnchor && fm.status !== 'done' && fm.status !== 'cancelled') {
        const eventDate = new Date(timeAnchor);
        if (!isNaN(eventDate.getTime()) && eventDate < now) {
          overdueCount++;
        }
      }

      // Resolve blockers: check which blocking events are still pending/upcoming
      let blockedByLabel: string | null = null;
      const blockedBy: Array<{ path: string; id: string }> = (fm.blocked_by as Array<{ path: string; id: string }>) ?? [];

      if (blockedBy.length > 0 && show_blocked !== false) {
        const pendingBlockers = blockedBy.filter(blocker => {
          const blockerFm = eventMap.get(blocker.path);
          return blockerFm && blockerFm.status !== 'done' && blockerFm.status !== 'cancelled';
        });

        if (pendingBlockers.length > 0) {
          const blockerTitles = pendingBlockers.map(b => {
            const bFm = eventMap.get(b.path);
            return bFm?.title ?? b.path.replace('events/', '').replace(/\.md$/, '');
          });
          blockedByLabel = `[blocked by: ${blockerTitles.join(', ')}]`;
        }
      }

      return {
        id: row.id,
        path: row.path,
        title: fm.title ?? '(untitled)',
        status: fm.status ?? 'upcoming',
        priority: fm.priority ?? 'normal',
        urgent: fm.urgent ?? false,
        important: fm.important ?? false,
        start_time: (fm.start_time || fm.remind_at) ?? null,
        end_time: fm.end_time ?? null,
        context: fm.context ?? 'uncategorized',
        tags: fm.tags ?? [],
        recurring: fm.recurring ?? null,
        blocked_by_label: blockedByLabel,
        checklist_progress: getChecklistProgress(body),
      };
    });

    // Apply priority and context filters (for 'all' filter these weren't applied above)
    const finalSummaries = eventSummaries.filter(ev => {
      if (priority && ev.priority !== priority) return false;
      if (context && !ev.context.toLowerCase().includes(context.toLowerCase())) return false;
      if (tag && !ev.tags.some(t => t.toLowerCase() === tag.toLowerCase())) return false;
      return true;
    });

    // 5. Group by context
    const grouped: Record<string, EventSummary[]> = {};

    for (const event of finalSummaries) {
      const ctx = event.context || 'uncategorized';
      if (!grouped[ctx]) grouped[ctx] = [];
      grouped[ctx].push(event);
    }

    // 6. Sort within each context group
    //    Order: urgent+important first, then high > normal > low, then soonest start_time first
    for (const ctx of Object.keys(grouped)) {
      grouped[ctx].sort((a, b) => {
        const pkA = prioritySortKey(a);
        const pkB = prioritySortKey(b);

        if (pkA !== pkB) return pkA - pkB;

        // Same priority bucket: soonest start_time first, null last
        if (a.start_time && b.start_time) {
          return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
        }
        if (a.start_time) return -1;
        if (b.start_time) return 1;
        return 0;
      });
    }

    // 7. Eisenhower triage suggestion
    const triageSuggested = overdueCount >= 5;

    return {
      success: true,
      events: grouped,
      total: finalSummaries.length,
      overdue_count: overdueCount,
      triage_suggested: triageSuggested,
      ...(triageSuggested
        ? {
            triage_message: `You have ${overdueCount} overdue events. Consider running Eisenhower triage to prioritize.`,
          }
        : {}),
    } as ListEventsResult;
  } catch (error: any) {
    return {
      success: false,
      events: {},
      total: 0,
      overdue_count: 0,
      triage_suggested: false,
      error: `Failed to list events: ${error.message}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* MCP tool definition                                                          */
/* -------------------------------------------------------------------------- */

export const listEventsToolDef = {
  name: 'list_events',
  description:
    'List events grouped by context, sorted by priority. Filter by today/upcoming/backlog/all, priority, context, or tag. Returns structured JSON — Claude formats for display. Blocked events shown with [blocked by: X] label. Suggests Eisenhower triage when 5+ events are overdue.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filter: {
        type: 'string' as const,
        enum: ['today', 'upcoming', 'backlog', 'all'] as const,
        description: 'today: events with start_time today | upcoming: next 7 days (default) | backlog: untimed events | all: all non-cancelled, non-done events',
      },
      priority: {
        type: 'string' as const,
        enum: ['low', 'normal', 'high'] as const,
        description: 'Filter by priority',
      },
      context: {
        type: 'string' as const,
        description: 'Filter by context (case-insensitive substring match)',
      },
      tag: {
        type: 'string' as const,
        description: 'Filter by tag (exact match, case-insensitive)',
      },
      show_blocked: {
        type: 'boolean' as const,
        description:
          'Show blocked events inline with [blocked by: X] label (default: true)',
      },
    },
    required: [] as const,
  },
};
