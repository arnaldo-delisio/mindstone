/**
 * gcal-poller.ts — Bidirectional GCal ↔ Vault sync
 *
 * Runs every 5 minutes via node-cron.
 * Polls all 4 calendars using syncToken incremental sync.
 * syncTokens persisted in gcal_sync_state Supabase table.
 *
 * On each changed event:
 * - vault-created event (gcal_event_id found in events/ files):
 *   - Moved in GCal → update start_time/end_time in vault
 *   - Deleted in GCal → hard DELETE from vault (daemon syncs to local)
 * - GCal-only event (not in vault):
 *   - confirmed → upsert into events/ with source='gcal'
 *   - cancelled → hard DELETE from vault if exists
 *
 * 410 GONE: syncToken expired → full resync, clear old token.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { USER_ID } from '../config.js';
import { isGcalEnabled, listChangedEvents } from './gcal.js';
import { logger } from '../utils/logger.js';
import { createHash } from 'crypto';
import matter from 'gray-matter';

const CALENDARS = ['personal', 'family', 'work', 'health'] as const;
type CalendarName = typeof CALENDARS[number];

export function startGcalPoller(): void {
  if (!isGcalEnabled()) {
    logger.info('GCal not configured — poller disabled');
    return;
  }

  logger.info('Starting GCal poller (every 5 minutes)');

  cron.schedule('*/5 * * * *', async () => {
    const start = Date.now();
    logger.debug('GCal poll tick');
    try {
      await pollAllCalendars();
      logger.debug({ durationMs: Date.now() - start }, 'GCal poll complete');
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - start }, 'GCal poll error');
    }
  });
}

async function pollAllCalendars(): Promise<void> {
  for (const calName of CALENDARS) {
    try {
      await pollCalendar(calName);
    } catch (err: any) {
      logger.error({ err, calendar: calName }, 'Calendar poll failed');
    }
  }
}

async function getSyncToken(calendarId: string): Promise<string | undefined> {
  const { data } = await supabase
    .from('gcal_sync_state')
    .select('sync_token')
    .eq('calendar_id', calendarId)
    .maybeSingle();
  return data?.sync_token ?? undefined;
}

async function saveSyncToken(calendarId: string, syncToken: string): Promise<void> {
  await supabase
    .from('gcal_sync_state')
    .upsert(
      { calendar_id: calendarId, sync_token: syncToken, last_synced_at: new Date().toISOString() },
      { onConflict: 'calendar_id' }
    );
}

async function clearSyncToken(calendarId: string): Promise<void> {
  await supabase
    .from('gcal_sync_state')
    .upsert(
      { calendar_id: calendarId, sync_token: null, last_synced_at: new Date().toISOString() },
      { onConflict: 'calendar_id' }
    );
}

// Get calendar ID from env var (same logic as gcal.ts getCalendarId)
function getCalEnvId(calName: string): string {
  const map: Record<string, string> = {
    personal: 'GCAL_CALENDAR_PERSONAL',
    family:   'GCAL_CALENDAR_FAMILY',
    work:     'GCAL_CALENDAR_WORK',
    health:   'GCAL_CALENDAR_HEALTH',
  };
  const calId = process.env[map[calName] ?? 'GCAL_CALENDAR_PERSONAL'];
  if (!calId) throw new Error(`Calendar env var not set for: ${calName}`);
  return calId;
}

async function pollCalendar(calName: CalendarName): Promise<void> {
  const calendarId = getCalEnvId(calName);
  const syncToken = await getSyncToken(calendarId);

  let result;
  try {
    result = await listChangedEvents(calName, syncToken);
  } catch (err: any) {
    if (err?.code === 410 || err?.message === 'GONE') {
      logger.warn({ calName }, 'GCal syncToken expired (410 GONE) — performing full resync');
      await clearSyncToken(calendarId);
      result = await listChangedEvents(calName, undefined); // full resync
    } else {
      throw err;
    }
  }

  if (result.events.length > 0) {
    logger.info({ calName, count: result.events.length }, 'GCal changed events found');
    await processChangedEvents(result.events, calName);
  }

  await saveSyncToken(calendarId, result.nextSyncToken);
}

async function processChangedEvents(
  events: Awaited<ReturnType<typeof listChangedEvents>>['events'],
  calName: CalendarName
): Promise<void> {
  for (const event of events) {
    try {
      await processOneEvent(event, calName);
    } catch (err) {
      logger.error({ err, eventId: event.id, calName }, 'Failed to process GCal event change');
    }
  }
}

async function processOneEvent(
  event: Awaited<ReturnType<typeof listChangedEvents>>['events'][0],
  calName: CalendarName
): Promise<void> {
  // Look up vault event by gcal_event_id (direct column on files table)
  const { data: vaultEvent } = await supabase
    .from('files')
    .select('id, path, frontmatter, body')
    .like('path', 'events/%')
    .eq('user_id', USER_ID)
    .eq('gcal_event_id', event.id)
    .maybeSingle();

  if (event.status === 'cancelled') {
    if (vaultEvent) {
      // GCal event deleted → hard delete vault event
      await supabase
        .from('files')
        .delete()
        .eq('path', vaultEvent.path)
        .eq('user_id', USER_ID);
      logger.info({ path: vaultEvent.path }, 'GCal deletion → vault event hard deleted');
    }
    return;
  }

  // Extract times from GCal event
  const startIso = event.start?.dateTime ?? event.start?.date;
  const endIso   = event.end?.dateTime   ?? event.end?.date;

  if (vaultEvent) {
    // Vault-created event: update start/end times if changed
    const fm = { ...vaultEvent.frontmatter } as Record<string, unknown>;
    let changed = false;

    if (startIso && fm.start_time !== startIso) {
      fm.start_time = startIso;
      changed = true;
    }
    if (endIso && fm.end_time !== endIso) {
      fm.end_time = endIso;
      changed = true;
    }

    if (changed) {
      await updateVaultFile(vaultEvent.path, fm, vaultEvent.body ?? '');
      logger.info({ path: vaultEvent.path, startIso }, 'GCal move → vault event time updated');
    }
  } else {
    // With singleEvents: false, recurring exceptions (individually rescheduled/cancelled
    // occurrences) still appear in results with recurringEventId set. Skip them — we track
    // the series as a whole, not individual instances.
    if (event.recurringEventId) return;

    // Skip all-day recurring series (birthdays, holidays, anniversaries).
    // Base recurring events have a `recurrence` array; all-day = no dateTime.
    // One-off all-day events (conferences, vacations) have no `recurrence` and still pass through.
    if (!event.start?.dateTime && event.recurrence?.length) return;

    const title = event.summary ?? `GCal event ${event.id.slice(0, 8)}`;
    const slug  = `gcal-${event.id.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 48)}`;
    const path  = `events/${slug}.md`;

    const fm: Record<string, unknown> = {
      title,
      status: 'upcoming',
      calendar: calName,
      gcal_event_id: event.id,
      gcal_calendar: calName,
      source: 'gcal',
      created: new Date().toISOString().slice(0, 10),
    };
    if (startIso) fm.start_time = startIso;
    if (endIso)   fm.end_time   = endIso;

    const body = '';
    const fullContent = matter.stringify(body, fm);
    const content_hash = createHash('sha256').update(fullContent).digest('hex');

    await supabase.from('files').upsert({
      path,
      frontmatter: fm,
      body,
      content_hash,
      user_id: USER_ID,
      gcal_event_id: event.id,
      gcal_calendar: calName,
      source: 'gcal',
      intelligence_status: 'complete',
      chunks_status: 'pending',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,path' });
    logger.info({ path, title }, 'GCal-only event upserted to vault');
  }
}

async function updateVaultFile(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<void> {
  const fullContent = matter.stringify(body, frontmatter);
  const content_hash = createHash('sha256').update(fullContent).digest('hex');

  await supabase
    .from('files')
    .update({ frontmatter, body, content_hash, updated_at: new Date().toISOString() })
    .eq('path', path)
    .eq('user_id', USER_ID);
}
