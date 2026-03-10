/**
 * get_calendar_events MCP tool
 *
 * Returns vault events for a given date range from the events/ folder.
 * Replaces morning_briefing for time-aware context.
 * Used by /morning skill, doctor persona, and any time-aware query.
 *
 * Filters:
 * - date: YYYY-MM-DD (defaults to today in your configured timezone)
 * - calendars: string[] of calendar names from calendars.json (defaults to all)
 * - include_backlog: include untimed events (default: false)
 */

import { supabase } from '../../services/supabase.js';
import { USER_ID } from '../../config.js';
import { VAULT_TIMEZONE } from '../../services/gcal.js';

export interface GetCalendarEventsArgs {
  /** YYYY-MM-DD. Defaults to today (your configured timezone). */
  date?: string;
  /** Which calendars to include. Defaults to all configured in calendars.json. */
  calendars?: string[];
  /** Include events for the next N days (1 = today only, 7 = week view). Default: 1 */
  days?: number;
  /** Include backlog events (no start_time). Default: false */
  include_backlog?: boolean;
}

export interface CalendarEvent {
  id: string;
  path: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  calendar: string;
  status: string;
  source: string | null;
  gcal_event_id: string | null;
}

export async function getCalendarEventsTool(args: GetCalendarEventsArgs): Promise<string> {
  try {
    const days = args.days ?? 1;
    const calendars = args.calendars ?? null;  // null means "all calendars"
    const includeBacklog = args.include_backlog ?? false;

    // Compute date range in UTC (events stored in UTC)
    // Default: today in your configured timezone (VAULT_TIMEZONE)
    const tzFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: VAULT_TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const todayLocal = args.date ?? tzFormatter.format(new Date());

    const startDate = new Date(todayLocal + 'T00:00:00Z');
    const endDate   = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);

    // Query events/ files with start_time in range
    let query = supabase
      .from('files')
      .select('id, path, frontmatter')
      .like('path', 'events/%')
      .eq('user_id', USER_ID)
      .neq('frontmatter->>status', 'cancelled')
      .neq('frontmatter->>status', 'done');

    if (!includeBacklog) {
      // Only timed events
      query = query.not('frontmatter->>start_time', 'is', null);
    }

    const { data, error } = await query;

    if (error) throw error;

    const events: CalendarEvent[] = [];

    for (const row of data ?? []) {
      const fm = row.frontmatter as Record<string, unknown>;
      const startTime = fm.start_time as string | null;
      const cal = (fm.calendar ?? fm.gcal_calendar ?? 'personal') as string;

      // Filter by calendar (null = all calendars)
      if (calendars !== null && !calendars.includes(cal)) continue;

      // Filter by date range (if start_time present)
      if (startTime) {
        const evStart = new Date(startTime);
        if (evStart < startDate || evStart >= endDate) continue;
      }

      events.push({
        id: row.id,
        path: row.path,
        title: (fm.title ?? '(untitled)') as string,
        start_time: startTime,
        end_time: (fm.end_time ?? null) as string | null,
        calendar: cal,
        status: (fm.status ?? 'upcoming') as string,
        source: (fm.source ?? null) as string | null,
        gcal_event_id: (fm.gcal_event_id ?? null) as string | null,
      });
    }

    // Sort by start_time ascending
    events.sort((a, b) => {
      if (!a.start_time) return 1;
      if (!b.start_time) return -1;
      return new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
    });

    return JSON.stringify({
      success: true,
      date: todayLocal,
      days,
      calendars,
      events,
      count: events.length,
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

export const getCalendarEventsToolDef = {
  name: 'get_calendar_events',
  description:
    'Get vault events for a date (defaults today, your configured timezone). Returns timed events from events/ folder across selected calendars. Use for morning briefing, day planning, scheduling context.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      date: {
        type: 'string' as const,
        description: 'Date to query (YYYY-MM-DD). Defaults to today (your configured timezone).',
      },
      calendars: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Calendar names to include (from vault/calendars.json). Default: all configured calendars.',
      },
      days: {
        type: 'number' as const,
        description: 'Number of days to include from date (1=today only, 7=week view). Default: 1',
      },
      include_backlog: {
        type: 'boolean' as const,
        description: 'Include untimed backlog events (default: false)',
      },
    },
    required: [] as const,
  },
};
