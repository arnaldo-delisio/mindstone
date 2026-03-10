/**
 * gcal.ts — Google Calendar API singleton
 *
 * All GCal operations flow through this module.
 * OAuth2 client initialized from env vars at module load.
 * Access tokens auto-refreshed by googleapis library before every call.
 *
 * Timezone: Configured via VAULT_TIMEZONE env var (default: UTC) — always pass timeZone with local datetime strings.
 *
 * Calendar routing: calendar name → gcal_id from calendars.json (loaded from Supabase files table).
 * Configure vault/calendars.json with your calendar names and Google Calendar IDs.
 */

import { google, calendar_v3 } from 'googleapis';
import { logger } from '../utils/logger.js';
import { supabase } from './supabase.js';
import { USER_ID } from '../config.js';

// Timezone for all GCal event operations. Set VAULT_TIMEZONE in .env (e.g. America/New_York).
export const VAULT_TIMEZONE = process.env.VAULT_TIMEZONE || 'UTC';

// Initialize OAuth2 client (singleton — module-level)
function initOAuth2Client() {
  const clientId     = process.env.GCAL_CLIENT_ID;
  const clientSecret = process.env.GCAL_CLIENT_SECRET;
  const refreshToken = process.env.GCAL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn('GCal env vars not set (GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN) — GCal features disabled');
    return null;
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

const auth = initOAuth2Client();
const gcalApi = auth ? google.calendar({ version: 'v3', auth }) : null;

export function isGcalEnabled(): boolean {
  return gcalApi !== null;
}

export async function loadCalendarsConfig(): Promise<Array<{name: string; gcal_id: string}>> {
  const { data, error } = await supabase
    .from('files')
    .select('body')
    .eq('path', 'calendars.json')
    .eq('user_id', USER_ID)
    .maybeSingle();

  if (error || !data?.body) {
    logger.warn('calendars.json not found in vault (sync it from your local vault first)');
    return [];
  }
  try {
    return JSON.parse(data.body);
  } catch {
    logger.error('calendars.json is invalid JSON — fix the file in your vault root');
    return [];
  }
}

/**
 * Resolve calendar name to Google Calendar ID from calendars.json (loaded from Supabase).
 * Throws if calendar not found in config.
 */
export async function getCalendarId(calendarName?: string): Promise<string> {
  const key = calendarName?.toLowerCase() ?? 'personal';
  const config = await loadCalendarsConfig();
  const entry = config.find(c => c.name.toLowerCase() === key);
  if (!entry) {
    throw new Error(`Calendar "${key}" not found in calendars.json. Add it to your vault's calendars.json file.`);
  }
  if (!entry.gcal_id || entry.gcal_id.includes('YOUR_')) {
    throw new Error(`Calendar "${key}" has a placeholder gcal_id in calendars.json — set the real Google Calendar ID.`);
  }
  return entry.gcal_id;
}

export interface GcalEventInput {
  title: string;
  /** ISO 8601 UTC string — converted to your configured timezone for GCal */
  start_time: string;
  /** ISO 8601 UTC string. If omitted, event duration = 15 minutes (reminder mode) */
  end_time?: string;
  calendar?: string;
  description?: string;
  /** minutes before start to fire popup notification (default: 0 = at start_time) */
  popup_minutes?: number;
  /** For recurring events: RRULE string e.g. "RRULE:FREQ=DAILY" */
  recurrence?: string;
}

export interface GcalEventResult {
  gcal_event_id: string;
  html_link: string;
}

/**
 * Create a GCal event. Throws on failure (strict: fail whole operation if GCal fails).
 */
export async function createGcalEvent(input: GcalEventInput): Promise<GcalEventResult> {
  if (!gcalApi) throw new Error('GCal not enabled — missing env vars');

  const calendarId = await getCalendarId(input.calendar);

  // End time defaults to start + 15 minutes (reminder mode)
  const startDt = new Date(input.start_time);
  const endDt = input.end_time
    ? new Date(input.end_time)
    : new Date(startDt.getTime() + 15 * 60 * 1000);

  const event: calendar_v3.Schema$Event = {
    summary: input.title,
    description: input.description,
    start: { dateTime: startDt.toISOString(), timeZone: VAULT_TIMEZONE },
    end:   { dateTime: endDt.toISOString(),   timeZone: VAULT_TIMEZONE },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: input.popup_minutes ?? 0 }],
    },
    ...(input.recurrence ? { recurrence: [input.recurrence] } : {}),
  };

  const { data } = await gcalApi.events.insert({ calendarId, requestBody: event });

  if (!data.id) throw new Error('GCal insert returned no event ID');

  logger.info({ gcal_event_id: data.id, calendarId }, 'GCal event created');
  return { gcal_event_id: data.id, html_link: data.htmlLink ?? '' };
}

/**
 * Update an existing GCal event (move in time or change title/description).
 * Uses patch — only sends changed fields.
 */
export async function updateGcalEvent(
  gcal_event_id: string,
  calendarName: string | undefined,
  updates: Partial<GcalEventInput>
): Promise<void> {
  if (!gcalApi) throw new Error('GCal not enabled — missing env vars');

  const calendarId = await getCalendarId(calendarName);
  const patch: calendar_v3.Schema$Event = {};

  if (updates.title) patch.summary = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;

  if (updates.start_time) {
    const startDt = new Date(updates.start_time);
    const endDt = updates.end_time
      ? new Date(updates.end_time)
      : new Date(startDt.getTime() + 15 * 60 * 1000);
    patch.start = { dateTime: startDt.toISOString(), timeZone: VAULT_TIMEZONE };
    patch.end   = { dateTime: endDt.toISOString(),   timeZone: VAULT_TIMEZONE };
  }

  await gcalApi.events.patch({ calendarId, eventId: gcal_event_id, requestBody: patch });
  logger.info({ gcal_event_id, calendarId }, 'GCal event updated');
}

/**
 * Delete a GCal event. Silently ignores 404 (already deleted).
 */
export async function deleteGcalEvent(gcal_event_id: string, calendarName?: string): Promise<void> {
  if (!gcalApi) return; // no-op if GCal not configured

  const calendarId = await getCalendarId(calendarName);

  try {
    await gcalApi.events.delete({ calendarId, eventId: gcal_event_id });
    logger.info({ gcal_event_id, calendarId }, 'GCal event deleted');
  } catch (err: any) {
    if (err?.status === 404 || err?.code === 404) {
      logger.debug({ gcal_event_id }, 'GCal event already deleted (404)');
      return;
    }
    throw err;
  }
}

export interface ChangedEvent {
  id: string;
  status: 'confirmed' | 'cancelled';
  summary?: string;
  start?: calendar_v3.Schema$EventDateTime;
  end?:   calendar_v3.Schema$EventDateTime;
  description?: string;
  /** Set on recurring instances — id of the parent recurring event */
  recurringEventId?: string;
  /** Set on recurring base events — array of RRULE/EXDATE strings */
  recurrence?: string[];
}

export interface ListChangedResult {
  events: ChangedEvent[];
  /** Pass as syncToken in next call */
  nextSyncToken: string;
}

/**
 * Incremental sync: fetch only events changed since last syncToken.
 * Pass syncToken=undefined for a full initial sync.
 * On 410 GONE, caller must clear syncToken and retry with syncToken=undefined.
 */
export async function listChangedEvents(
  calendarName: string,
  syncToken?: string
): Promise<ListChangedResult> {
  if (!gcalApi) throw new Error('GCal not enabled — missing env vars');

  const calendarId = await getCalendarId(calendarName);

  try {
    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId,
      ...(syncToken ? { syncToken } : {
        // Full sync: only future events + 30 days back
        timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      singleEvents: false,
      maxResults: 2500,
    };

    const { data } = await gcalApi.events.list(params);
    const events: ChangedEvent[] = (data.items ?? []).map(e => ({
      id: e.id!,
      status: (e.status ?? 'confirmed') as 'confirmed' | 'cancelled',
      summary: e.summary ?? undefined,
      start: e.start ?? undefined,
      end: e.end ?? undefined,
      description: e.description ?? undefined,
      recurringEventId: e.recurringEventId ?? undefined,
      recurrence: e.recurrence ?? undefined,
    }));

    return { events, nextSyncToken: data.nextSyncToken! };
  } catch (err: any) {
    if (err?.status === 410 || err?.code === 410) {
      // syncToken expired — caller must do full resync
      const goneError = new Error('GONE') as Error & { code: number };
      goneError.code = 410;
      throw goneError;
    }
    throw err;
  }
}
